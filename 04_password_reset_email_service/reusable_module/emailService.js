const axios = require('axios');
const crypto = require('crypto');

/**
 * Validates whether the given string is a valid email address.
 * @param {string} email 
 * @returns {boolean}
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Sends an email using the Resend HTTP API.
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} [options.from] - Sender address (optional, overrides environment default)
 * @param {string} [options.apiKey] - Resend API key (optional, overrides environment default)
 * @returns {Promise<Object>} Resend API JSON response containing the email ID
 */
async function sendEmail({ to, subject, html, from, apiKey }) {
  const finalApiKey = apiKey || process.env.RESEND_API_KEY;
  const finalFrom = from || process.env.MAIL_FROM;

  if (!finalApiKey) {
    console.error('[EmailService] Failed to send email: RESEND_API_KEY is not configured.');
    throw new Error('Resend API key is not configured');
  }
  if (!finalFrom) {
    console.error('[EmailService] Failed to send email: MAIL_FROM is not configured.');
    throw new Error('Mail sender (MAIL_FROM) is not configured');
  }

  try {
    const res = await axios.post('https://api.resend.com/emails', {
      from: finalFrom,
      to,
      subject,
      html
    }, {
      headers: {
        'Authorization': `Bearer ${finalApiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000 // 15 seconds timeout
    });
    console.log(`[EmailService] Email sent successfully to ${to}, Resend ID: ${res.data.id}`);
    return res.data;
  } catch (error) {
    const errMsg = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error(`[EmailService] Failed to send email to ${to}:`, errMsg);
    throw new Error(`Email sending failed: ${errMsg}`);
  }
}

/**
 * Hashes a verification code using HMAC-SHA256 to prevent plaintext exposure in databases/cache.
 * @param {string} code - The raw verification code
 * @param {string} [secret] - The HMAC secret (optional, overrides env.PASSWORD_RESET_SECRET)
 * @returns {string} The hex-encoded HMAC hash
 */
function hashVerificationCode(code, secret) {
  const finalSecret = secret || process.env.PASSWORD_RESET_SECRET || 'default_hmac_secret_key_2026';
  return crypto.createHmac('sha256', finalSecret).update(code).digest('hex');
}

module.exports = {
  isValidEmail,
  sendEmail,
  hashVerificationCode
};
