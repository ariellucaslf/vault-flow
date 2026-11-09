import { Router } from 'express';
import { requireInternalApiToken } from '../middleware/internalAuth.middleware';
import projectRoutes from './project.routes';

const router = Router();

// Todas as rotas operacionais exigem autenticação por token interno de servidor
router.use(requireInternalApiToken);
router.use('/projects', projectRoutes);

export default router;
