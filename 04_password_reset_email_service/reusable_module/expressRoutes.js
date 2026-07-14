const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { isValidEmail, sendEmail, hashVerificationCode } = require('./emailService');

// Redis key helper prefix
const REDIS_PREFIX = 'reusable_email:';
const getRedisKey = (key) => `${REDIS_PREFIX}${key}`;

/**
 * Creates an Express Router with email verification and password reset routes.
 * @param {Object} redis - An instance of ioredis client
 * @param {Object} [options] - Custom options
 * @param {Function} [options.authMiddleware] - Authentication middleware (required for email binding)
 * @param {Function} [options.updateUserEmailFn] - Callback to update user's email in DB (username, email) => Promise
 * @param {Function} [options.updateUserPasswordFn] - Callback to update user's password in DB (username, newPasswordHash) => Promise
 * @param {Function} [options.getUserByEmailFn] - Callback to lookup user by email (email) => Promise<username | null>
 * @param {Function} [options.hashPasswordFn] - Callback to hash the new password (password) => Promise<string>
 * @returns {express.Router}
 */
module.exports = function createEmailRouter(redis, options = {}) {
  const router = express.Router();

  // Rate Limiter: maximum of 10 auth-related requests per 15 minutes per IP
  const emailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: '请求过于频繁，请 15 分钟后再试' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Default mock functions if none are passed in
  const getUsernameByEmail = options.getUserByEmailFn || async (email) => {
    return await redis.get(getRedisKey(`email_to_user:${email}`));
  };

  const updateUserEmail = options.updateUserEmailFn || async (username, email) => {
    await redis.set(getRedisKey(`user_email:${username}`), email);
    await redis.set(getRedisKey(`email_to_user:${email}`), username);
  };

  const updateUserPassword = options.updateUserPasswordFn || async (username, newPasswordHash) => {
    await redis.set(getRedisKey(`user_password_hash:${username}`), newPasswordHash);
    // Optionally invalidate existing tokens
    await redis.del(getRedisKey(`user_token:${username}`));
  };

  const defaultAuthMiddleware = options.authMiddleware || ((req, res, next) => {
    // Expected req.user containing username. Replace this with your actual auth logic.
    if (!req.headers.authorization) {
      return res.status(401).json({ error: '请先登录' });
    }
    req.user = { username: req.headers.authorization }; // Mock username from authorization header
    next();
  });

  const hashPassword = options.hashPasswordFn || (async (pw) => {
    const salt = crypto.randomBytes(16).toString('hex');
    return crypto.createHash('sha256').update(pw + salt).digest('hex') + ':' + salt;
  });

  // ==========================================
  // 1. Request Email Bind Verification Code
  // ==========================================
  router.post('/email/request-code', emailLimiter, defaultAuthMiddleware, async (req, res) => {
    const { email } = req.body;
    const username = req.user.username;

    if (!email) {
      return res.status(400).json({ error: '邮箱地址不能为空' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    try {
      // Check if email is already bound to another account
      const existingUser = await getUsernameByEmail(normalizedEmail);
      if (existingUser && existingUser !== username) {
        return res.status(400).json({ error: '该邮箱已被其他账号绑定' });
      }

      // Rate limit: 60s per email address
      const rateKey = getRedisKey(`rate:email-bind:${normalizedEmail}`);
      const isRateLimited = await redis.get(rateKey);
      if (isRateLimited) {
        return res.status(429).json({ error: '获取验证码过于频繁，请在 60 秒后重试' });
      }

      // Generate 6-digit verification code
      const code = crypto.randomInt(100000, 1000000).toString();
      const codeHash = hashVerificationCode(code);

      const bindData = {
        username,
        codeHash,
        attempts: 0,
        createdAt: new Date().toISOString()
      };

      // Save to Redis (valid for 15 minutes)
      const bindKey = getRedisKey(`email-bind:${normalizedEmail}`);
      await redis.setex(bindKey, 900, JSON.stringify(bindData));
      await redis.setex(rateKey, 60, '1'); // 60s limit

      // Send Verification Email
      const emailHtml = `
        <div style="font-family: sans-serif; padding: 20px; color: #333;">
          <h2>您好 ${username}，</h2>
          <p>您正在进行邮箱绑定，您的验证码为：</p>
          <div style="font-size: 24px; font-weight: bold; background-color: #f0f4f8; padding: 15px; border-radius: 5px; text-align: center; color: #0070f3; letter-spacing: 5px; margin: 20px 0;">
            ${code}
          </div>
          <p>验证码在 15 分钟内有效，请勿将验证码泄露给他人。</p>
          <hr style="border: 0; border-top: 1px solid #eaeaea; margin: 30px 0;" />
          <p style="font-size: 12px; color: #666;">此邮件由系统自动发送，请勿直接回复。</p>
        </div>
      `;

      await sendEmail({
        to: normalizedEmail,
        subject: '邮箱绑定验证码',
        html: emailHtml
      });

      return res.json({ success: true, message: '验证码已发送，请查收' });
    } catch (error) {
      console.error('[EmailRouter] Request bind code failed:', error);
      return res.status(500).json({ error: '发送验证码失败，请稍后重试' });
    }
  });

  // ==========================================
  // 2. Confirm Email Binding
  // ==========================================
  router.post('/email/confirm', emailLimiter, defaultAuthMiddleware, async (req, res) => {
    const { email, code } = req.body;
    const username = req.user.username;

    if (!email || !code) {
      return res.status(400).json({ error: '参数不完整' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    try {
      const bindKey = getRedisKey(`email-bind:${normalizedEmail}`);
      const bindDataStr = await redis.get(bindKey);
      if (!bindDataStr) {
        return res.status(400).json({ error: '验证码不存在或已过期' });
      }

      const bindData = JSON.parse(bindDataStr);

      if (bindData.username !== username) {
        return res.status(400).json({ error: '验证码与当前账号不匹配' });
      }

      // Verify code hash
      const codeHash = hashVerificationCode(code);
      if (bindData.codeHash !== codeHash) {
        bindData.attempts += 1;
        if (bindData.attempts >= 5) {
          await redis.del(bindKey); // Self-destruct after 5 failed attempts
          return res.status(400).json({ error: '验证码输入错误次数过多，已失效' });
        }
        await redis.setex(bindKey, 900, JSON.stringify(bindData));
        return res.status(400).json({ error: '验证码错误' });
      }

      // Success: delete verification record
      await redis.del(bindKey);

      // Double check binding conflicts
      const existingUser = await getUsernameByEmail(normalizedEmail);
      if (existingUser && existingUser !== username) {
        return res.status(400).json({ error: '该邮箱已被其他账号绑定' });
      }

      // Persist the email association in DB
      await updateUserEmail(username, normalizedEmail);

      return res.json({ success: true, message: '邮箱绑定成功' });
    } catch (error) {
      console.error('[EmailRouter] Confirm email bind failed:', error);
      return res.status(500).json({ error: '绑定失败，服务器内部错误' });
    }
  });

  // ==========================================
  // 3. Request Password Reset Verification Code
  // ==========================================
  router.post('/password-reset/request', emailLimiter, async (req, res) => {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: '邮箱地址不能为空' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    // Generic response to mitigate account enumeration
    const successResponse = {
      success: true,
      message: '如果您的邮箱已注册，重置验证码已发送至您的邮箱，请检查收件箱（包括垃圾箱）。'
    };

    try {
      // Rate limit: 60s per email address
      const rateKey = getRedisKey(`rate:password-reset:${normalizedEmail}`);
      const isRateLimited = await redis.get(rateKey);
      if (isRateLimited) {
        return res.status(429).json({ error: '获取验证码过于频繁，请在 60 秒后重试' });
      }

      // Lookup email owner
      const username = await getUsernameByEmail(normalizedEmail);
      if (!username) {
        // Obfuscation: Return success even if email is unregistered
        console.log(`[EmailRouter] Password reset request for unregistered email: ${normalizedEmail}`);
        return res.json(successResponse);
      }

      // Generate 6-digit verification code
      const code = crypto.randomInt(100000, 1000000).toString();
      const codeHash = hashVerificationCode(code);

      const resetData = {
        username,
        codeHash,
        attempts: 0,
        createdAt: new Date().toISOString()
      };

      // Save to Redis (valid for 15 minutes)
      const resetKey = getRedisKey(`password-reset:${normalizedEmail}`);
      await redis.setex(resetKey, 900, JSON.stringify(resetData));
      await redis.setex(rateKey, 60, '1'); // 60s limit

      // Send Reset Email
      const emailHtml = `
        <div style="font-family: sans-serif; padding: 20px; color: #333;">
          <h2>您好 ${username}，</h2>
          <p>您正在申请重置密码，您的重置验证码为：</p>
          <div style="font-size: 24px; font-weight: bold; background-color: #fdf2f2; padding: 15px; border-radius: 5px; text-align: center; color: #dc2626; letter-spacing: 5px; margin: 20px 0;">
            ${code}
          </div>
          <p>验证码在 15 分钟内有效。如果您没有申请重置密码，请忽略此邮件，您的账号仍然安全。</p>
          <hr style="border: 0; border-top: 1px solid #eaeaea; margin: 30px 0;" />
          <p style="font-size: 12px; color: #666;">此邮件由系统自动发送，请勿直接回复。</p>
        </div>
      `;

      await sendEmail({
        to: normalizedEmail,
        subject: '密码重置验证码',
        html: emailHtml
      });

      return res.json(successResponse);
    } catch (error) {
      console.error('[EmailRouter] Request password reset failed:', error);
      return res.status(500).json({ error: '重置请求失败，请稍后重试' });
    }
  });

  // ==========================================
  // 4. Confirm Password Reset
  // ==========================================
  router.post('/password-reset/confirm', emailLimiter, async (req, res) => {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: '参数不完整' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: '新密码长度至少为 8 位' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    try {
      const resetKey = getRedisKey(`password-reset:${normalizedEmail}`);
      const resetDataStr = await redis.get(resetKey);
      if (!resetDataStr) {
        return res.status(400).json({ error: '验证码已过期或不存在' });
      }

      const resetData = JSON.parse(resetDataStr);
      const username = resetData.username;

      // Verify code hash
      const codeHash = hashVerificationCode(code);
      if (resetData.codeHash !== codeHash) {
        resetData.attempts += 1;
        if (resetData.attempts >= 5) {
          await redis.del(resetKey); // Self-destruct after 5 failed attempts
          return res.status(400).json({ error: '验证码输入错误次数过多，已失效' });
        }
        await redis.setex(resetKey, 900, JSON.stringify(resetData));
        return res.status(400).json({ error: '验证码错误' });
      }

      // Success: delete reset record
      await redis.del(resetKey);

      // Hash and update password
      const newPasswordHash = await hashPassword(newPassword);
      await updateUserPassword(username, newPasswordHash);

      return res.json({ success: true, message: '密码重置成功，请使用新密码登录' });
    } catch (error) {
      console.error('[EmailRouter] Confirm password reset failed:', error);
      return res.status(500).json({ error: '密码重置失败，服务器内部错误' });
    }
  });

  return router;
};
