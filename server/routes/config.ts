import { Router, Request, Response } from 'express';
import { getPresignedUrlTtlOptions } from '../config/presignedUrls.js';

const router = Router();

router.get('/', (_req: Request, res: Response): void => {
  res.json({
    presignedUrlTtls: getPresignedUrlTtlOptions(),
  });
});

export default router;
