
import { FinalizeDesignButton } from './FinalizeDesignButton';
import type { DesignMdState } from '../hooks/useDesignMdState';
import type { FinalizeStatus } from '../hooks/useFinalizeProject';

export interface ProjectActionsToolbarProps {
  designMdState: Pick<DesignMdState, 'exists' | 'isStale' | 'staleReason'>;
  finalizeStatus: FinalizeStatus;
  onFinalize: () => void;
  onCancelFinalize: () => void;
  onContinueInCli: () => void | Promise<void>;
  hidden?: boolean;
}

export function ProjectActionsToolbar({
  designMdState,
  finalizeStatus,
  onFinalize,
  onCancelFinalize,
  onContinueInCli,
  hidden,
}: ProjectActionsToolbarProps) {
  if (hidden) return null;
  return (
    <div
      className="project-actions-toolbar"
      role="toolbar"
      aria-label="Project actions"
    >
      <FinalizeDesignButton
        designMdState={designMdState}
        status={finalizeStatus}
        onFinalize={onFinalize}
        onCancel={onCancelFinalize}
      />
      
    </div>
  );
}
