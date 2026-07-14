# Reusable Email Verification & Password Reset Module

This folder contains a fully modularized, production-ready email verification and password reset service built on **Resend** and **Redis**. It is designed to be easily copied and reused in other Node.js projects.

## Module Structure

```text
reusable_module/
├── README.md             # This document (setup & guide)
├── emailService.js       # Reusable core email utility module
├── expressRoutes.js      # Express API endpoints templates
└── .env.example          # Environment variables template
```

---

## 1. Domain Configuration (DNS Setup)

To send emails using your own domain (e.g. `auth.yourdomain.com`) through Resend, you must configure DNS records at your domain provider (e.g. Cloudflare). 

Below are the typical records required by Resend:

### DKIM (DomainKeys Identified Mail)
- **Type**: `TXT`
- **Name**: `resend._domainkey.auth` (for subdomain `auth.yourdomain.com`) or `resend._domainkey` (for root domain)
- **Value**: `k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQ...` (provided by Resend)

### SPF (Sender Policy Framework)
- **Type**: `TXT`
- **Name**: `send.auth` (subdomain) or `send` (root)
- **Value**: `v=spf1 include:amazonses.com ~all` (or similar provided by Resend)

### MX (Mail Exchange)
- **Type**: `MX`
- **Name**: `send.auth` (subdomain) or `send` (root)
- **Value**: `feedback-smtp.us-east-1.amazonses.com` (Priority: `10`, provided by Resend)

> [!NOTE]
> Ensure you only copy the *subdomain prefix* when setting records in Cloudflare (e.g., input `resend._domainkey.auth` in the Name field instead of the full `resend._domainkey.auth.yourdomain.com`).

---

## 2. Resend Setup & API Keys

1. Register at [Resend](https://resend.com).
2. Go to **Domains** -> **Add Domain** -> Verify DNS records.
3. Once the status shows **Verified**, go to **API Keys** -> **Create API Key**.
   - Set permission to **Sending access** (limit it to the verified domain for security).
4. Save the API Key into your `.env` file.

---

## 3. Environment Variables Configuration

Copy `.env.example` to your main project `.env` file:

```dotenv
RESEND_API_KEY=re_xxxxxx
MAIL_FROM=YourAppName <no-reply@auth.yourdomain.com>
PASSWORD_RESET_SECRET=your_secure_random_hmac_secret_for_hashing_verification_codes
```

---

## 4. How to Integrate and Reuse

1. **Copy Files**: Copy `emailService.js` and `expressRoutes.js` into your backend folder.
2. **Install Dependencies**:
   ```bash
   npm install axios bcryptjs express express-rate-limit ioredis
   ```
3. **Register Routes**: In your main Express app entrypoint (e.g. `server.js` or `app.js`):
   ```javascript
   const redis = new Redis(...); // Set up ioredis
   const emailRoutes = require('./expressRoutes')(redis);
   app.use('/api', emailRoutes);
   ```
4. **Customize Email Templates**: Edit `expressRoutes.js` to modify the HTML email content as desired.
