/**
 * Unit tests for upload-validation.js
 * Run: node --test tests/unit/upload-validation.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  fileFilter,
  ALLOWED_MEDIA_MIMES,
  ALLOWED_DOCUMENT_MIMES,
  ALLOWED_INVOICE_MIMES,
  ALLOWED_KYC_MIMES,
  ALLOWED_CHAT_MIMES,
} from '../../src/lib/upload-validation.js';

function createFile(mimetype) {
  return { mimetype, fieldname: 'file', originalname: 'test', size: 0 };
}

function fileFilterPromise(allowed, label, mimetype) {
  return new Promise((resolve, reject) => {
    const filter = fileFilter(allowed, label);
    filter(null, createFile(mimetype), (err, accept) => {
      if (err) reject(err);
      else resolve(accept);
    });
  });
}

describe('upload-validation', () => {
  describe('ALLOWED_MEDIA_MIMES', () => {
    const media = (mime) => fileFilterPromise(ALLOWED_MEDIA_MIMES, 'Media', mime);
    it('accepts image/jpeg', async () => assert.strictEqual(await media('image/jpeg'), true));
    it('accepts image/png', async () => assert.strictEqual(await media('image/png'), true));
    it('accepts image/gif', async () => assert.strictEqual(await media('image/gif'), true));
    it('accepts image/webp', async () => assert.strictEqual(await media('image/webp'), true));
    it('accepts video/mp4', async () => assert.strictEqual(await media('video/mp4'), true));
    it('accepts video/webm', async () => assert.strictEqual(await media('video/webm'), true));
    it('rejects application/pdf', async () => await assert.rejects(() => media('application/pdf')));
    it('rejects text/plain', async () => await assert.rejects(() => media('text/plain')));
    it('rejects application/x-msdownload', async () => await assert.rejects(() => media('application/x-msdownload')));
  });

  describe('ALLOWED_DOCUMENT_MIMES', () => {
    const doc = (mime) => fileFilterPromise(ALLOWED_DOCUMENT_MIMES, 'Document', mime);
    it('accepts application/pdf', async () => assert.strictEqual(await doc('application/pdf'), true));
    it('accepts image/jpeg', async () => assert.strictEqual(await doc('image/jpeg'), true));
    it('rejects video/mp4', async () => await assert.rejects(() => doc('video/mp4')));
  });

  describe('ALLOWED_INVOICE_MIMES', () => {
    const inv = (mime) => fileFilterPromise(ALLOWED_INVOICE_MIMES, 'Invoice', mime);
    it('accepts application/pdf', async () => assert.strictEqual(await inv('application/pdf'), true));
    it('accepts image/png', async () => assert.strictEqual(await inv('image/png'), true));
    it('accepts image/jpeg', async () => assert.strictEqual(await inv('image/jpeg'), true));
    it('accepts docx', async () =>
      assert.strictEqual(await inv('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), true));
    it('rejects video/mp4', async () => await assert.rejects(() => inv('video/mp4')));
  });

  describe('ALLOWED_KYC_MIMES', () => {
    const kyc = (mime) => fileFilterPromise(ALLOWED_KYC_MIMES, 'KYC', mime);
    it('accepts image/jpeg', async () => assert.strictEqual(await kyc('image/jpeg'), true));
    it('accepts image/png', async () => assert.strictEqual(await kyc('image/png'), true));
    it('accepts application/pdf', async () => assert.strictEqual(await kyc('application/pdf'), true));
    it('rejects application/octet-stream', async () => await assert.rejects(() => kyc('application/octet-stream')));
  });

  describe('ALLOWED_CHAT_MIMES', () => {
    const chat = (mime) => fileFilterPromise(ALLOWED_CHAT_MIMES, 'Chat', mime);
    it('accepts image/png', async () => assert.strictEqual(await chat('image/png'), true));
    it('accepts audio/mpeg', async () => assert.strictEqual(await chat('audio/mpeg'), true));
    it('accepts video/mp4', async () => assert.strictEqual(await chat('video/mp4'), true));
    it('accepts application/pdf', async () => assert.strictEqual(await chat('application/pdf'), true));
    it('rejects text/html', async () => await assert.rejects(() => chat('text/html')));
  });

  describe('fileFilter error message', () => {
    it('includes label and mimetype in error', async () => {
      try {
        await fileFilterPromise(ALLOWED_INVOICE_MIMES, 'Invoice attachment', 'video/mp4');
        assert.fail('expected reject');
      } catch (e) {
        assert.match(e.message, /Invoice attachment/);
        assert.match(e.message, /video\/mp4/);
      }
    });
  });

  describe('edge cases', () => {
    it('rejects null mimetype', async () => {
      await assert.rejects(() => fileFilterPromise(ALLOWED_MEDIA_MIMES, 'Media', null));
    });
    it('rejects empty string mimetype', async () => {
      await assert.rejects(() => fileFilterPromise(ALLOWED_MEDIA_MIMES, 'Media', ''));
    });
  });
});
