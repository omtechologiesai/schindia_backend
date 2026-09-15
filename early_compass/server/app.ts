import express from 'express';
import helmet from 'helmet';
import { config } from './config';
import { errorHandler, HttpError, loadSession, requireAppHeader, requireUser } from './http';
import { assessmentsRouter } from './routes/assessments';
import { authRouter } from './routes/auth';
import { checklistRouter } from './routes/checklist';
import { childrenRouter } from './routes/children';
import { deliveriesRouter, metaRouter } from './routes/meta';
import { publicRouter } from './routes/public';
import { usersRouter } from './routes/users';

/**
 * The API and the parents' report pages, all under BASE_PATH (/compass) so the app can share a site
 * with the Shichida admin app. The staff portal is built from the frontend repo and served by nginx.
 */
export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Upgrading requests breaks a plain-http deployment (e.g. testing on a LAN), so only on https.
          upgradeInsecureRequests: config.cookieSecure ? [] : null,
        },
      },
      referrerPolicy: { policy: 'same-origin' },
    }),
  );

  const site = express.Router();

  site.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  site.use('/r', publicRouter);

  site.use('/api', express.json({ limit: '256kb' }), loadSession, requireAppHeader);
  site.use('/api/auth', authRouter);
  site.use('/api', requireUser);
  site.use('/api/meta', metaRouter);
  site.use('/api/checklist', checklistRouter);
  site.use('/api/children', childrenRouter);
  site.use('/api/assessments', assessmentsRouter);
  site.use('/api/deliveries', deliveriesRouter);
  site.use('/api/users', usersRouter);
  site.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  app.use(config.basePath || '/', site);
  app.use(errorHandler);
  return app;
}
