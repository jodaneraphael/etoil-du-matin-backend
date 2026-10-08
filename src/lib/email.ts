import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../env.js';
import { logger, maskEmail } from './logger.js';

type MailOptions = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

let transporter: Transporter | null = null;

const createTransporter = (): Transporter | null => {
  if (!env.smtpEnabled) return null;
  return nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpPort === 465,
    auth: { user: env.smtpUser, pass: env.smtpPassword },
    pool: true,
    maxConnections: 1,
  });
};

const getTransporter = (): Transporter | null => {
  if (transporter) return transporter;
  transporter = createTransporter();
  return transporter;
};

export const sendEmail = async (opts: MailOptions): Promise<boolean> => {
  const tx = getTransporter();
  if (!tx) {
    logger.info({ to: maskEmail(opts.to), subject: opts.subject }, 'smtp not configured; skipping email');
    return false;
  }
  try {
    const info = await tx.sendMail({ from: env.mailFrom, to: opts.to, subject: opts.subject, text: opts.text, html: opts.html });
    logger.info({ to: maskEmail(opts.to), subject: opts.subject, messageId: info.messageId }, 'email sent');
    return true;
  } catch (error) {
    logger.error({ err: error, to: maskEmail(opts.to), subject: opts.subject }, 'failed to send email');
    return false;
  }
};

export const sendPasswordResetCode = async (to: string, code: string): Promise<boolean> => {
  const subject = 'Your password reset code';
  const text = 'Your password reset code is: ' + code + '\n\nThis code expires in 15 minutes. If you did not request this, ignore this email.';
  const html = '<p>Your password reset code is: <strong>' + code + '</strong></p><p>This code expires in 15 minutes. If you did not request this, ignore this email.</p>';
  return sendEmail({ to, subject, text, html });
};

export const sendOrderConfirmation = async (to: string, orderNumber: string, totalCents: number, currency: string): Promise<boolean> => {
  const subject = 'Order ' + orderNumber + ' confirmed';
  const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(totalCents / 100);
  const text = 'Your order ' + orderNumber + ' has been confirmed and is being processed.\nTotal: ' + formatted + '\n\nThank you for your order.';
  const html = '<p>Your order <strong>' + orderNumber + '</strong> has been confirmed and is being processed.</p><p>Total: <strong>' + formatted + '</strong></p><p>Thank you for your order.</p>';
  return sendEmail({ to, subject, text, html });
};

export const sendShippingUpdate = async (to: string, orderNumber: string, trackingCarrier: string | null, trackingNumber: string): Promise<boolean> => {
  const carrier = trackingCarrier ?? 'Carrier';
  const subject = 'Your order ' + orderNumber + ' has shipped';
  const text = 'Your order ' + orderNumber + ' has shipped.\nTracking: ' + carrier + ' - ' + trackingNumber + '\n\nYou can track your delivery using the provided tracking number.';
  const html = '<p>Your order <strong>' + orderNumber + '</strong> has shipped.</p><p>Tracking: <strong>' + carrier + ' - ' + trackingNumber + '</strong></p><p>You can track your delivery using the provided tracking number.</p>';
  return sendEmail({ to, subject, text, html });
};
