'use strict';

/**
 * asaasService.js
 * ---------------------------------------------------------------------------
 * Integração com o gateway de pagamento Asaas — portada de asaas.server.ts
 * do projeto original, adaptada para este backend em Node/Express.
 * ---------------------------------------------------------------------------
 */

const fetch = require('node-fetch');

const PLANS = {
  monthly: { id: 'monthly', label: 'Plano Mensal', price: 99, recurring: true },
  lifetime: { id: 'lifetime', label: 'Plano Vitalício', price: 299, recurring: false },
};

function apiBase() {
  return (process.env.ASAAS_BASE_URL || 'https://api.asaas.com/v3').replace(/\/$/, '');
}

function apiKey() {
  const key = process.env.ASAAS_API_KEY;
  if (!key) throw new Error('ASAAS_API_KEY não configurada.');
  return key;
}

async function asaasFetch(path, init) {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // O Asaas exige User-Agent em todas as requisições (erro user_agent_not_informed).
      'User-Agent': 'GeradorEbook/1.0',
      access_token: apiKey(),
      ...(init && init.headers ? init.headers : {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Asaas ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function findOrCreateCustomer({ name, email, cpfCnpj }) {
  const existing = await asaasFetch(`/customers?email=${encodeURIComponent(email)}`);
  if (existing.data && existing.data[0] && existing.data[0].id) {
    return existing.data[0].id;
  }
  const created = await asaasFetch('/customers', {
    method: 'POST',
    body: JSON.stringify({
      name,
      email,
      cpfCnpj: (cpfCnpj || '').replace(/\D/g, ''),
    }),
  });
  return created.id;
}

function dueDate(daysAhead) {
  const date = new Date();
  date.setDate(date.getDate() + (daysAhead || 0));
  return date.toISOString().slice(0, 10);
}

async function createLifetimeCharge({ customerId, description, externalReference, value = PLANS.lifetime.price }) {
  const payment = await asaasFetch('/payments', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerId,
      billingType: 'UNDEFINED', // deixa o cliente escolher PIX, boleto ou cartão
      value,
      dueDate: dueDate(3),
      description,
      externalReference,
    }),
  });
  return { paymentId: payment.id, subscriptionId: null, url: payment.invoiceUrl };
}

async function createMonthlySubscription({ customerId, description, externalReference, value = PLANS.monthly.price }) {
  const subscription = await asaasFetch('/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerId,
      billingType: 'UNDEFINED',
      value,
      nextDueDate: dueDate(0),
      cycle: 'MONTHLY',
      description,
      externalReference,
    }),
  });

  const payments = await asaasFetch(`/subscriptions/${subscription.id}/payments`);
  const first = payments.data && payments.data[0];
  return {
    paymentId: first ? first.id : null,
    subscriptionId: subscription.id,
    url: first ? first.invoiceUrl : '',
  };
}

async function getPaymentStatus(paymentId) {
  const payment = await asaasFetch(`/payments/${paymentId}`);
  return { id: payment.id, status: payment.status, value: payment.value };
}

module.exports = {
  PLANS,
  findOrCreateCustomer,
  createLifetimeCharge,
  createMonthlySubscription,
  getPaymentStatus,
};
