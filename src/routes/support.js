import express from 'express';

const router = express.Router();

/** GET /api/v1/support-options - public support links (Zoom, WhatsApp, booking) for client support UI */
router.get('/support-options', (_req, res) => {
  res.json({
    liveChat: true,
    zoomUrl: process.env.SUPPORT_ZOOM_URL || null,
    whatsappNumber: process.env.SUPPORT_WHATSAPP_NUMBER || null,
    bookingUrl: process.env.SUPPORT_BOOKING_URL || null,
  });
});

export default router;
