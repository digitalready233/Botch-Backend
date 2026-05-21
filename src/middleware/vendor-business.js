import { resolveVendorBusinessStatus } from '../lib/vendor-business.js';

const ENFORCE_VENDOR_GATE = process.env.VENDOR_BUSINESS_GATE_ENFORCE === 'true';

export async function attachVendorBusinessStatus(req, _res, next) {
  try {
    if (req.userRole !== 'vendor' || !req.userId) return next();
    req.vendorBusinessStatus = await resolveVendorBusinessStatus(null, req.userId);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireActiveVendorBusiness(options = {}) {
  const enforce = options.enforce ?? ENFORCE_VENDOR_GATE;
  const exposeHeader = options.exposeHeader ?? true;
  return async (req, res, next) => {
    try {
      if (req.userRole !== 'vendor' || !req.userId) return next();
      if (!req.vendorBusinessStatus) {
        req.vendorBusinessStatus = await resolveVendorBusinessStatus(null, req.userId);
      }
      const status = req.vendorBusinessStatus;
      if (exposeHeader) {
        res.setHeader('X-Botch-Vendor-Business-Status', status.code || 'unknown');
      }
      if (status.active || !enforce) return next();
      return res.status(403).json({
        error: 'Vendor account is not active for business operations yet.',
        code: 'VENDOR_BUSINESS_INACTIVE',
        vendor_business: {
          status: status.code,
          reason: status.reason,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}

export { ENFORCE_VENDOR_GATE };
