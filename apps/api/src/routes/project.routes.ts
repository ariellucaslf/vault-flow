import { Router } from 'express';
import {
  reconcileProjectsCron,
  triggerBackup,
} from '../controllers/project.controller';

const router = Router();

router.post('/reconcile', reconcileProjectsCron);
router.post('/:id/trigger', triggerBackup);

export default router;
