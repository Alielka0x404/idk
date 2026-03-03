/**
 * SendGrid Email Module for ClawGPT
 * Sends transactional emails via SendGrid API
 */

const https = require('https');

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const FROM_EMAIL = 'notificaciones@magnitracking.info';
const FROM_NAME = 'ClawGPT';

/**
 * Send an email via SendGrid
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} text - Plain text body
 * @param {string} html - HTML body (optional)
 */
function sendEmail(to, subject, text, html) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      content: [
        { type: 'text/plain', value: text },
        ...(html ? [{ type: 'text/html', value: html }] : []),
      ],
    });

    const options = {
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, to });
        } else {
          reject(new Error(`SendGrid error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Send email to multiple recipients
 * @param {string[]} recipients - Array of email addresses
 * @param {string} subject - Email subject
 * @param {string} text - Plain text body
 * @param {string} html - HTML body (optional)
 */
async function sendBulk(recipients, subject, text, html) {
  const results = await Promise.allSettled(
    recipients.map((to) => sendEmail(to, subject, text, html))
  );
  return results.map((r, i) => ({
    to: recipients[i],
    success: r.status === 'fulfilled',
    error: r.status === 'rejected' ? r.reason.message : null,
  }));
}

module.exports = { sendEmail, sendBulk };
