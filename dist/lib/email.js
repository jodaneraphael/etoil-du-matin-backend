import nodemailer from 'nodemailer';
import { env } from '../env.js';
import { logger, maskEmail } from './logger.js';
let transporter = null;
const createTransporter = () => {
    if (!env.smtpEnabled)
        return null;
    return nodemailer.createTransport({
        host: env.smtpHost,
        port: env.smtpPort,
        secure: env.smtpPort === 465,
        auth: { user: env.smtpUser, pass: env.smtpPassword },
        pool: true,
        maxConnections: 1,
    });
};
const getTransporter = () => {
    if (transporter)
        return transporter;
    transporter = createTransporter();
    return transporter;
};
export const sendEmail = async (opts) => {
    const tx = getTransporter();
    if (!tx) {
        logger.info({ to: maskEmail(opts.to), subject: opts.subject }, 'smtp not configured; skipping email');
        return false;
    }
    try {
        const info = await tx.sendMail({ from: env.mailFrom, to: opts.to, subject: opts.subject, text: opts.text, html: opts.html });
        logger.info({ to: maskEmail(opts.to), subject: opts.subject, messageId: info.messageId }, 'email sent');
        return true;
    }
    catch (error) {
        logger.error({ err: error, to: maskEmail(opts.to), subject: opts.subject }, 'failed to send email');
        return false;
    }
};
export const sendPasswordResetCode = async (to, code) => {
    const subject = 'Your password reset code';
    const text = 'Your password reset code is: ' + code + '\n\nThis code expires in 15 minutes. If you did not request this, ignore this email.';
    const html = '<p>Your password reset code is: <strong>' + code + '</strong></p><p>This code expires in 15 minutes. If you did not request this, ignore this email.</p>';
    return sendEmail({ to, subject, text, html });
};
export const sendOrderConfirmation = async (to, orderNumber, totalCents, currency) => {
    const subject = 'Order ' + orderNumber + ' confirmed';
    const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(totalCents / 100);
    const text = 'Your order ' + orderNumber + ' has been confirmed and is being processed.\nTotal: ' + formatted + '\n\nThank you for your order.';
    const html = '<p>Your order <strong>' + orderNumber + '</strong> has been confirmed and is being processed.</p><p>Total: <strong>' + formatted + '</strong></p><p>Thank you for your order.</p>';
    return sendEmail({ to, subject, text, html });
};
export const sendShippingUpdate = async (to, orderNumber, trackingCarrier, trackingNumber) => {
    const carrier = trackingCarrier ?? 'Carrier';
    const subject = 'Your order ' + orderNumber + ' has shipped';
    const text = 'Your order ' + orderNumber + ' has shipped.\nTracking: ' + carrier + ' - ' + trackingNumber + '\n\nYou can track your delivery using the provided tracking number.';
    const html = '<p>Your order <strong>' + orderNumber + '</strong> has shipped.</p><p>Tracking: <strong>' + carrier + ' - ' + trackingNumber + '</strong></p><p>You can track your delivery using the provided tracking number.</p>';
    return sendEmail({ to, subject, text, html });
};
export const sendSupplierPurchaseOrder = async (to, po) => {
    const lines = po.items.map((i) => '  - ' + i.quantity + ' x ' + i.name + (i.sku ? ' (' + i.sku + ')' : '')).join('\n');
    const subject = 'Purchase order ' + po.orderNumber + ' (' + po.reference + ')';
    const text = 'Hello ' + po.supplierName + ',\n\n' +
        'Please fulfil the following order.\n\n' +
        'Order: ' + po.orderNumber + '\n' +
        'Reference: ' + po.reference + '\n\n' +
        'Items:\n' + lines + '\n\n' +
        'Ship to:\n' + po.shipTo + '\n\n' +
        'When it ships, report the status and tracking number to:\n' +
        po.callbackUrl + '\n' +
        'with the header  X-EDM-Token: ' + po.token + '\n';
    const rows = po.items
        .map((i) => '<tr><td>' + i.quantity + '</td><td>' + i.name + '</td><td>' + (i.sku ?? '') + '</td></tr>')
        .join('');
    const html = '<p>Hello <strong>' + po.supplierName + '</strong>,</p>' +
        '<p>Please fulfil order <strong>' + po.orderNumber + '</strong> (reference ' + po.reference + ').</p>' +
        '<table cellpadding="6" style="border-collapse:collapse"><thead><tr><th align="left">Qty</th><th align="left">Item</th><th align="left">SKU</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p><strong>Ship to:</strong><br>' + po.shipTo.replace(/\n/g, '<br>') + '</p>' +
        '<p>Report shipping status and tracking to <code>' + po.callbackUrl + '</code> with header <code>X-EDM-Token: ' + po.token + '</code>.</p>';
    return sendEmail({ to, subject, text, html });
};
export const sendDeliveredUpdate = async (to, orderNumber) => {
    const subject = 'Your order ' + orderNumber + ' was delivered';
    const text = 'Your order ' + orderNumber + ' has been marked delivered. We hope you love it.';
    const html = '<p>Your order <strong>' + orderNumber + '</strong> has been marked delivered. We hope you love it.</p>';
    return sendEmail({ to, subject, text, html });
};
//# sourceMappingURL=email.js.map