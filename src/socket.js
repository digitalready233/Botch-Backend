import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import pool from './db/index.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export function createSocketServer(httpServer, corsOptions) {
  const io = new Server(httpServer, {
    cors: typeof corsOptions === 'object' && corsOptions !== null && !Array.isArray(corsOptions)
      ? corsOptions
      : { origin: corsOptions, credentials: true },
    // Dot-free path: Vercel reliably routes /api/* to Next; /socket.io often 404s before the app runs.
    path: process.env.SOCKET_IO_PATH || '/api/socket-io',
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Auth required'));
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (!decoded.userId) return next(new Error('Invalid token'));
      socket.data.userId = decoded.userId;
      socket.data.role = decoded.role;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    const role = socket.data.role;
    socket.join(`user:${userId}`);

    // Notify project rooms when this user comes online (after they join a project)
    socket.on('join_project', async (payload, cb) => {
      const projectId = payload?.projectId;
      if (!projectId) return cb?.({ error: 'projectId required' });
      try {
        const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [projectId]);
        if (rows.length === 0) return cb?.({ error: 'Project not found' });
        const proj = rows[0];
        const allowed =
          role === 'admin' || role === 'super_admin' || (role === 'client' && proj.client_id === userId);
        if (!allowed) return cb?.({ error: "You don't have permission to do that." });
        socket.join(`project:${projectId}`);
        if (!socket.data.projectIds) socket.data.projectIds = [];
        if (!socket.data.projectIds.includes(projectId)) socket.data.projectIds.push(projectId);
        // Broadcast presence: this user is now online in this project
        socket.to(`project:${projectId}`).emit('presence:online', { userId, projectId, role });
        cb?.({ ok: true });
      } catch (err) {
        cb?.({ error: err.message });
      }
    });

    socket.on('leave_project', (payload) => {
      const projectId = payload?.projectId;
      if (projectId) {
        if (socket.data.projectIds) {
          socket.data.projectIds = socket.data.projectIds.filter((id) => id !== projectId);
        }
        socket.to(`project:${projectId}`).emit('presence:offline', { userId, projectId });
        socket.leave(`project:${projectId}`);
      }
    });

    socket.on('call:started', async (payload) => {
      const projectId = payload?.projectId;
      const roomName = payload?.roomName;
      const callType = payload?.callType || 'video';
      if (projectId) {
        let callerName = '';
        try {
          const { rows } = await pool.query('SELECT full_name FROM users WHERE id = $1', [userId]);
          if (rows[0]?.full_name) callerName = rows[0].full_name;
          else {
            const u = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
            callerName = u.rows[0]?.email || 'Someone';
          }
        } catch (_) {}
        const callPayload = {
          userId,
          projectId,
          roomName: roomName || `project-${projectId}`,
          callerName: callerName.trim() || 'Someone',
          callType: callType === 'voice' ? 'voice' : 'video',
        };
        socket.to(`project:${projectId}`).emit('call:started', callPayload);
        // Also emit to project's client and vendor so they get the call even when not in project room
        try {
          const { rows: projRows } = await pool.query('SELECT client_id FROM projects WHERE id = $1', [projectId]);
          if (projRows.length > 0) {
            const { client_id } = projRows[0];
            const recipientIds = [client_id].filter(Boolean).filter((id) => id !== userId);
            recipientIds.forEach((recipientId) => {
              io.to(`user:${recipientId}`).emit('call:started', callPayload);
            });
          }
        } catch (_) {}
      }
    });

    socket.on('call:ended', async (payload) => {
      const projectId = payload?.projectId;
      const roomName = payload?.roomName || (projectId ? `project-${projectId}` : undefined);
      const endPayload = { userId, projectId, roomName };
      if (projectId) {
        socket.to(`project:${projectId}`).emit('call:ended', endPayload);
        try {
          const { rows: projRows } = await pool.query('SELECT client_id FROM projects WHERE id = $1', [projectId]);
          if (projRows.length > 0) {
            const { client_id } = projRows[0];
            [client_id].filter(Boolean).forEach((recipientId) => {
              io.to(`user:${recipientId}`).emit('call:ended', endPayload);
            });
          }
        } catch (_) {}
      }
    });

    socket.on('typing_start', (payload) => {
      const projectId = payload?.projectId;
      const recipientId = payload?.recipientId;
      if (projectId) socket.to(`project:${projectId}`).emit('typing_start', { userId, projectId });
      if (recipientId) socket.to(`user:${recipientId}`).emit('typing_start', { userId, projectId: payload?.projectId });
    });

    socket.on('typing_stop', (payload) => {
      const projectId = payload?.projectId;
      const recipientId = payload?.recipientId;
      if (projectId) socket.to(`project:${projectId}`).emit('typing_stop', { userId, projectId });
      if (recipientId) socket.to(`user:${recipientId}`).emit('typing_stop', { userId, projectId: payload?.projectId });
    });

    socket.on('disconnect', () => {
      const projectIds = socket.data.projectIds || [];
      projectIds.forEach((projectId) => {
        socket.to(`project:${projectId}`).emit('presence:offline', { userId, projectId });
      });
    });
  });

  return io;
}

export function getIO(app) {
  return app.get('io');
}

/** Check if a user is currently in a project room (online). Used for WhatsApp-style delivered receipt. */
export function isUserInProjectRoom(io, projectId, userId) {
  if (!io?.sockets?.adapter?.rooms || !projectId || !userId) return false;
  const room = io.sockets.adapter.rooms.get(`project:${projectId}`);
  if (!room) return false;
  for (const socketId of room) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket?.data?.userId === userId) return true;
  }
  return false;
}
