const mockStore = new Map();

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => {
    return {
      status: 'ready',
      get: jest.fn().mockImplementation((key) => Promise.resolve(mockStore.get(key) || null)),
      set: jest.fn().mockImplementation((key, val) => {
        mockStore.set(key, val);
        return Promise.resolve('OK');
      }),
      setex: jest.fn().mockImplementation((key, sec, val) => {
        mockStore.set(key, val);
        return Promise.resolve('OK');
      }),
      del: jest.fn().mockImplementation((key) => {
        mockStore.delete(key);
        return Promise.resolve(1);
      }),
      on: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
    };
  });
});

// Mock axios specifically to prevent sending real emails but mock target responses
jest.mock('axios', () => {
  const actualAxios = jest.requireActual('axios');
  return {
    ...actualAxios,
    post: jest.fn().mockImplementation((url, data, config) => {
      if (url.includes('api.resend.com')) {
        return Promise.resolve({ data: { id: 'mock-resend-id-12345' } });
      }
      return actualAxios.post(url, data, config);
    }),
    get: jest.fn().mockImplementation((url, config) => {
      return actualAxios.get(url, config);
    })
  };
});

const request = require('supertest');
const { app, redis, getRedisKey } = require('./server');

const TEST_USER = 'test_jest_user';
const TEST_PASS = 'test_jest_password';
let testToken = '';

describe('Bio-Downloader Backend API Tests', () => {
  beforeAll(() => {
    mockStore.clear();
  });

  afterAll(async () => {
    mockStore.clear();
    await redis.quit();
  });

  describe('POST /api/auth/register', () => {
    it('should successfully register a new user', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: TEST_USER, password: TEST_PASS });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.trafficLimit).toBe(209715200); // 200MB default trial
      
      testToken = res.body.token;
    });

    it('should reject duplicate registration', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: TEST_USER, password: TEST_PASS });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('用户名已存在');
    });

    it('should fail registration with missing fields', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: TEST_USER });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('用户名和密码不能为空');
    });
  });

  describe('POST /api/auth/login', () => {
    it('should login successfully with correct credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: TEST_USER, password: TEST_PASS });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toEqual(testToken);
    });

    it('should fail login with wrong password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: TEST_USER, password: 'wrong_password' });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('密码错误');
    });
  });

  describe('GET /api/user/info', () => {
    it('should retrieve user info with valid token', async () => {
      const res = await request(app)
        .get('/api/user/info')
        .query({ token: testToken });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.username).toEqual(TEST_USER);
    });

    it('should fail info retrieval with invalid token', async () => {
      const res = await request(app)
        .get('/api/user/info')
        .query({ token: 'invalid_token' });

      expect(res.statusCode).toEqual(401);
      expect(res.body.error).toBe('无效Token');
    });
  });

  describe('GET /api/pay/packages', () => {
    it('should return available packages list', async () => {
      const res = await request(app)
        .get('/api/pay/packages');

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.packages)).toBe(true);
      expect(res.body.packages.length).toBeGreaterThan(0);
    });
  });

  describe('Email Binding and Password Reset API Flows', () => {
    const BIND_EMAIL = 'bind_user@example.com';
    const REG_EMAIL = 'reg_user@example.com';

    it('should register a new user with an email successfully', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'reg_user', password: 'password123', email: REG_EMAIL });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);

      // Verify Redis mapping was saved
      const userKey = getRedisKey('user:reg_user');
      const userObj = JSON.parse(mockStore.get(userKey));
      expect(userObj.email).toEqual(REG_EMAIL);

      const emailMapKey = getRedisKey(`email:${REG_EMAIL}`);
      expect(mockStore.get(emailMapKey)).toEqual('reg_user');
    });

    it('should reject registration with duplicate email', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'another_user', password: 'password123', email: REG_EMAIL });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toEqual('该邮箱已被注册');
    });

    it('should successfully request an email binding verification code', async () => {
      const res = await request(app)
        .post('/api/user/email/request-code')
        .send({ token: testToken, email: BIND_EMAIL });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);

      // Check that a bind code is written to mockStore
      const bindKey = getRedisKey(`email-bind:${BIND_EMAIL}`);
      expect(mockStore.has(bindKey)).toBe(true);
    });

    it('should confirm email binding with correct code', async () => {
      const bindKey = getRedisKey(`email-bind:${BIND_EMAIL}`);
      const bindData = JSON.parse(mockStore.get(bindKey));
      
      const testCode = '654321';
      const crypto = require('crypto');
      const testHash = crypto.createHmac('sha256', 'biodl_password_reset_secret_default_2026').update(testCode).digest('hex');
      
      bindData.codeHash = testHash;
      mockStore.set(bindKey, JSON.stringify(bindData));

      const res = await request(app)
        .post('/api/user/email/confirm')
        .send({ token: testToken, email: BIND_EMAIL, code: testCode });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);

      // Verify email binding state on user
      const userKey = getRedisKey(`user:${TEST_USER}`);
      const userObj = JSON.parse(mockStore.get(userKey));
      expect(userObj.email).toEqual(BIND_EMAIL);
    });

    it('should request password reset with unified success response', async () => {
      const res = await request(app)
        .post('/api/auth/password-reset/request')
        .send({ email: BIND_EMAIL });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('如果您的邮箱已在系统中注册');

      // Check reset key in Redis
      const resetKey = getRedisKey(`password-reset:${BIND_EMAIL}`);
      expect(mockStore.has(resetKey)).toBe(true);
    });

    it('should reset password with correct verification code and invalidate old token', async () => {
      const resetKey = getRedisKey(`password-reset:${BIND_EMAIL}`);
      const resetData = JSON.parse(mockStore.get(resetKey));

      const testCode = '123456';
      const crypto = require('crypto');
      const testHash = crypto.createHmac('sha256', 'biodl_password_reset_secret_default_2026').update(testCode).digest('hex');
      
      resetData.codeHash = testHash;
      mockStore.set(resetKey, JSON.stringify(resetData));

      const res = await request(app)
        .post('/api/auth/password-reset/confirm')
        .send({ email: BIND_EMAIL, code: testCode, newPassword: 'new_long_password123' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);

      // Check login with new password
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: TEST_USER, password: 'new_long_password123' });

      expect(loginRes.statusCode).toEqual(200);
      expect(loginRes.body.success).toBe(true);

      // Check old token is deleted
      const oldTokenKey = getRedisKey(`token:${testToken}`);
      expect(mockStore.has(oldTokenKey)).toBe(false);
    });
  });
});
