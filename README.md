# Paraslis — Full-stack ecommerce

Based on the supplied Paraslis frontend. It now includes a Node/Express backend, product API, cart, checkout/order API, bulk quote API, contact API, order tracking, protected admin order-status API, PostgreSQL support, JSON development fallback, and optional Razorpay integration.

## Local
```bash
npm install
cp .env.example .env
npm start
```
Open `http://localhost:3000`.

With no `DATABASE_URL`, local orders/quotes/contacts are saved in `data/store.json`.

## Production database
Set `DATABASE_URL` to PostgreSQL. Tables are created automatically on startup.

## Razorpay
Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to enable the payment endpoints. Never put the secret in frontend code.

## Admin
Use header `x-admin-key: YOUR_ADMIN_KEY`.
- `GET /api/admin/orders`
- `PATCH /api/admin/orders/:id/status`

## Deployment
For Render/Railway/other Node hosts: build with `npm ci`, start with `npm start`, and provide a PostgreSQL `DATABASE_URL`. Add `ADMIN_KEY`. Add Razorpay keys only if online payment is needed.

The frontend and API are served from the same Node service, so no separate frontend deployment is required.

## API
GET `/api/health`
GET `/api/products`
GET `/api/products/:id`
POST `/api/orders`
POST `/api/quotes`
POST `/api/contact`
GET `/api/orders/track/:id`
POST `/api/payments/razorpay/order`
POST `/api/payments/razorpay/verify`

## Admin dashboard
After deployment open `/admin.html`, enter `ADMIN_KEY`, and manage order statuses.

## Online payments
When Razorpay keys are configured, the checkout shows Online Payment and verifies the Razorpay signature server-side before creating the paid order. COD/UPI/manual checkout remains available without Razorpay.
