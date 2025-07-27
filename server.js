const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const crypto = require('crypto');
const axios = require('axios');

dotenv.config();
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(bodyParser.json());

// Validate Telegram initData
function validateInitData(initDataRaw, botToken) {
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const dataCheckString = initDataRaw.split('&').filter(p => !p.startsWith('hash=')).sort().join('\n');
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const providedHash = initDataRaw.split('&').find(p => p.startsWith('hash=')).split('=')[1];
  return hash === providedHash;
}

// Auth endpoint
app.post('/api/auth', async (req, res) => {
  const { initData } = req.body;
  if (!validateInitData(initData, process.env.TELEGRAM_BOT_TOKEN)) {
    return res.status(401).json({ error: 'Invalid auth' });
  }
  const params = new URLSearchParams(initData);
  const user = JSON.parse(params.get('user'));
  const { rows } = await pool.query(
    'INSERT INTO users (tg_id, username, first_name) VALUES ($1, $2, $3) ON CONFLICT (tg_id) DO UPDATE SET username = $2, first_name = $3 RETURNING *',
    [user.id, user.username, user.first_name]
  );
  res.json({ user: rows[0] });
});

// Participate (create or join group)
app.post('/api/participate', async (req, res) => {
  const { tg_id, ref_code } = req.body;
  let groupId;
  if (ref_code) {
    // Join existing
    const { rows } = await pool.query('SELECT group_id FROM group_members WHERE invite_code = $1', [ref_code]);
    if (!rows.length) return res.status(404).json({ error: 'Invalid ref' });
    groupId = rows[0].group_id;
    await pool.query('INSERT INTO group_members (group_id, user_tg_id) VALUES ($1, $2)', [groupId, tg_id]);
  } else {
    // Create new
    const { rows: group } = await pool.query('INSERT INTO groups (initiator_tg_id) VALUES ($1) RETURNING id', [tg_id]);
    groupId = group[0].id;
    const invite1 = crypto.randomBytes(8).toString('hex');
    const invite2 = crypto.randomBytes(8).toString('hex');
    await pool.query('INSERT INTO group_members (group_id, user_tg_id, invite_code) VALUES ($1, $2, $3), ($1, $2, $4)', [groupId, tg_id, invite1, invite2]);
  }
  // Create payment entry
  const product = (await pool.query('SELECT * FROM products LIMIT 1')).rows[0];
  await pool.query('INSERT INTO payments (group_id, user_tg_id, amount) VALUES ($1, $2, $3)', [groupId, tg_id, product.discounted_price]);
  res.json({ groupId, start_time: (await pool.query('SELECT start_time FROM groups WHERE id = $1', [groupId])).rows[0].start_time });
});

// Get invite links
app.get('/api/invites/:tg_id', async (req, res) => {
  const { tg_id } = req.params;
  const { rows } = await pool.query('SELECT invite_code FROM group_members WHERE user_tg_id = $1 AND invite_code IS NOT NULL', [tg_id]);
  const links = rows.map(r => `https://t.me/yourbot?startapp=ref_${r.invite_code}`);
  res.json({ links });
});

// Payment init (Payme example; similar for Click)
app.post('/api/payment/init', async (req, res) => {
  const { group_id, user_tg_id, provider } = req.body;
  const { rows } = await pool.query('SELECT * FROM payments WHERE group_id = $1 AND user_tg_id = $2', [group_id, user_tg_id]);
  const payment = rows[0];
  if (provider === 'payme') {
    // Payme CreateTransaction
    const params = {
      id: Date.now(),
      method: 'CheckPerformTransaction',
      params: { amount: payment.amount * 100, account: { order_id: payment.id } } // Adjust as per docs
    };
    try {
      const response = await axios.post('https://checkout.paycom.uz/api', params, {
        auth: { username: process.env.PAYME_MERCHANT_ID, password: process.env.PAYME_KEY }
      });
      if (response.data.result.allow) {
        // Then CreateTransaction
        const createParams = {
          id: Date.now(),
          method: 'CreateTransaction',
          params: { amount: payment.amount * 100, account: { order_id: payment.id }, time: Date.now() + 12*60*60*1000 }
        };
        const createRes = await axios.post('https://checkout.paycom.uz/api', createParams, {
          auth: { username: process.env.PAYME_MERCHANT_ID, password: process.env.PAYME_KEY }
        });
        const transactionId = createRes.data.result.transaction;
        await pool.query('UPDATE payments SET transaction_id = $1, provider = $2 WHERE id = $3', [transactionId, provider, payment.id]);
        res.json({ payment_url: `https://payme.uz/pay/${transactionId}` }); // Adjust URL
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  } else if (provider === 'click') {
    // Click Prepare
    const params = {
      service_id: process.env.CLICK_MERCHANT_ID,
      merchant_trans_id: payment.id,
      amount: payment.amount,
      return_url: 'your_callback_url',
      // Add more as per docs
    };
    try {
      const response = await axios.post('https://api.click.uz/v2/merchant/invoice/create', params, {
        headers: { 'Auth': process.env.CLICK_SECRET }
      });
      const invoiceId = response.data.invoice_id;
      await pool.query('UPDATE payments SET transaction_id = $1, provider = $2 WHERE id = $3', [invoiceId, provider, payment.id]);
      res.json({ payment_url: `https://my.click.uz/pay/${invoiceId}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
});

// Callback (for Payme/Click webhooks)
app.post('/api/payment/callback', async (req, res) => {
  const data = req.body; // Parse based on provider
  // Validate signature, etc.
  // For Payme example
  if (data.method === 'PerformTransaction') {
    const transactionId = data.params.id;
    const { rows } = await pool.query('SELECT * FROM payments WHERE transaction_id = $1', [transactionId]);
    const payment = rows[0];
    await pool.query('UPDATE payments SET status = $1 WHERE id = $2', ['paid', payment.id]);
    await pool.query('UPDATE group_members SET paid = TRUE WHERE group_id = $1 AND user_tg_id = $2', [payment.group_id, payment.user_tg_id]);
    // Check if group complete
    const { rows: members } = await pool.query('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE paid) AS paid FROM group_members WHERE group_id = $1', [payment.group_id]);
    if (members[0].paid === 3) {
      await pool.query('UPDATE groups SET status = $1 WHERE id = $2', ['completed', payment.group_id]);
    } else if (new Date() > new Date((await pool.query('SELECT start_time FROM groups WHERE id = $1', [payment.group_id])).rows[0].start_time + 24*60*60*1000)) {
      await pool.query('UPDATE groups SET status = $1 WHERE id = $2', ['failed', payment.group_id]);
    }
  }
  // Similar for Click Complete
  res.json({ success: true });
});

// Get group status
app.get('/api/group/:id', async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query('SELECT * FROM groups WHERE id = $1', [id]);
  const group = rows[0];
  const timeLeft = 24*60*60*1000 - (new Date() - new Date(group.start_time));
  const { rows: members } = await pool.query('SELECT * FROM group_members WHERE group_id = $1', [id]);
  res.json({ group, timeLeft, members });
});

// Language switch
app.post('/api/language', async (req, res) => {
  const { tg_id, lang } = req.body;
  await pool.query('UPDATE users SET language = $1 WHERE tg_id = $2', [lang, tg_id]);
  res.json({ success: true });
});

const port = process.env.PORT || 5000; // Использует порт Render или 5000 по умолчанию
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});