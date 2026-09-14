const transporter = require('../config/email');

// Sends an alert email to the owner. Never throws - email failures are logged, not fatal.
async function sendOwnerAlert(subject, text) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER, // change to owner's real email later
      subject,
      text
    });
  } catch (emailErr) {
    console.log('Alert email failed to send:', emailErr.message);
  }
}

function lowStockAlert(item) {
  return sendOwnerAlert(
    `⚠️ Low Stock Alert - ${item.item_name}`,
    `${item.item_name} (${item.department}) is at ${item.quantity}, at or below the minimum of ${item.min_quantity}.`
  );
}

module.exports = { sendOwnerAlert, lowStockAlert };
