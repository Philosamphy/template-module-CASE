import type { WorkflowStep } from "../domain/schemas.js";

export interface NotificationRequest {
  instanceId: string;
  step: WorkflowStep;
  recipient: string;
  message: string;
}

/**
 * Outbound notification port. The default implementation only logs: the module
 * must never send real messages just because a template contains a
 * notification step. Swap in a real adapter (email/Telegram) once those
 * integrations exist.
 */
export interface NotificationPort {
  notify(request: NotificationRequest): Promise<void>;
}

export class SimulatedNotificationPort implements NotificationPort {
  readonly sent: NotificationRequest[] = [];

  async notify(request: NotificationRequest): Promise<void> {
    this.sent.push(request);
    console.log(
      `[notify:SIMULATED] instance=${request.instanceId} step=${request.step.id} to=${request.recipient}`,
    );
  }
}
