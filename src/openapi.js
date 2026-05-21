const API_VERSION = process.env.API_VERSION || 'v1';

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Botch Realty API',
    version: '1.0.0',
    description: 'API for diaspora investors: auth, projects, payments, invoices, media, messages, notifications, KYC.',
  },
  servers: [{ url: `http://localhost:${process.env.PORT || 4000}/api/${API_VERSION}`, description: 'Local' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/auth/register': {
      post: {
        summary: 'Register',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' }, fullName: { type: 'string' } } } } } },
        responses: { 201: { description: 'Created' } },
      },
    },
    '/auth/login': {
      post: {
        summary: 'Login',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  email: { type: 'string' },
                  password: { type: 'string' },
                  otp_method: { type: 'string', enum: ['email', 'authenticator'], description: 'Use "email" to get a one-time code by email/SMS instead of Google Authenticator when both are enabled.' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'OK or requiresOtp/requiresTwoFa' }, 401: { description: 'Invalid credentials' } },
      },
    },
    '/auth/otp/verify': {
      post: {
        summary: 'Verify login OTP',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { otpToken: { type: 'string' }, code: { type: 'string' } } } } } },
        responses: { 200: { description: 'Tokens' } },
      },
    },
    '/auth/2fa/login': {
      post: {
        summary: 'Complete login with 2FA code',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { twoFaToken: { type: 'string' }, code: { type: 'string' } } } } } },
        responses: { 200: { description: 'Tokens' } },
      },
    },
    '/auth/change-password': {
      post: {
        summary: 'Change password (authenticated)',
        description:
          'Requires current password. New password must be at least 8 characters and different from the current one. Rate-limited per IP. Logged in audit as password_changed.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['current_password', 'new_password', 'confirm_password'],
                properties: {
                  current_password: { type: 'string', format: 'password' },
                  new_password: { type: 'string', format: 'password', minLength: 8 },
                  confirm_password: { type: 'string', format: 'password', description: 'Must match new_password' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Password updated', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } } } } } },
          400: { description: 'Validation error or passwords do not match' },
          401: { description: 'Incorrect current password' },
          429: { description: 'Too many attempts' },
          503: { description: 'Unavailable' },
        },
      },
    },
    '/payments/bank-details': {
      get: { summary: 'Get bank transfer details', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Bank details' } } },
    },
    '/payments/request-bank-transfer': {
      post: {
        summary: 'Request bank transfer (client)',
        security: [{ bearerAuth: [] }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { invoice_id: { type: 'string', format: 'uuid' } } } } } },
        responses: { 201: { description: 'Pending payment created' } },
      },
    },
    '/payments/initialize': {
      post: {
        summary: 'Initialize Paystack payment',
        security: [{ bearerAuth: [] }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { invoice_id: { type: 'string', format: 'uuid' } } } } } },
        responses: { 200: { description: 'authorization_url' } },
      },
    },
    '/kyc/status': {
      get: { summary: 'KYC status (client: own, admin: pending list)', security: [{ bearerAuth: [] }], responses: { 200: { description: 'OK' } } },
    },
    '/kyc/upload': {
      post: {
        summary: 'Upload KYC document (client)',
        security: [{ bearerAuth: [] }],
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, document_type: { type: 'string', enum: ['id_front', 'id_back', 'passport', 'other'] } } } } } },
        responses: { 201: { description: 'Created' } },
      },
    },
    '/kyc/{id}/review': {
      patch: {
        summary: 'Approve/reject KYC (admin)',
        security: [{ bearerAuth: [] }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['approved', 'rejected'] }, rejection_reason: { type: 'string' } } } } } },
        responses: { 200: { description: 'OK' } },
      },
    },
    '/projects': {
      get: { summary: 'List projects', security: [{ bearerAuth: [] }], responses: { 200: { description: 'OK' } } },
    },
    '/invoices': {
      get: { summary: 'List invoices', security: [{ bearerAuth: [] }], responses: { 200: { description: 'OK' } } },
      post: { summary: 'Create invoice (admin)', security: [{ bearerAuth: [] }], responses: { 201: { description: 'Created' } } },
    },
    '/media': {
      get: { summary: 'List media by project', security: [{ bearerAuth: [] }], parameters: [{ name: 'project_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'OK' } } },
      post: { summary: 'Create media with URL (admin)', security: [{ bearerAuth: [] }], responses: { 201: { description: 'Created' } } },
    },
    '/media/upload': {
      post: {
        summary: 'Upload media file (admin). S3 if configured.',
        security: [{ bearerAuth: [] }],
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, project_id: { type: 'string' }, media_type: { type: 'string', enum: ['photo', 'video', 'drone'] }, title: { type: 'string' } } } } } },
        responses: { 201: { description: 'Created' } },
      },
    },
    '/notifications': {
      get: { summary: 'List notifications', security: [{ bearerAuth: [] }], responses: { 200: { description: 'OK' } } },
    },
  },
};
