import { Router } from 'express';
import {
  listProjects,
  reconcileProjectsCron,
  triggerBackup,
} from '../controllers/project.controller';

const router = Router();

router.get('/', listProjects);
router.post('/reconcile', reconcileProjectsCron);
router.post('/:id/trigger', triggerBackup);

export default router;
