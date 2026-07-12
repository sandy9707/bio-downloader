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
});
