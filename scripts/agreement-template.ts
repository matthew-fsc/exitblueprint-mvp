// The default engagement-agreement template moved to shared/ so server code can
// source it too (the Docker image ships shared/ but not scripts/). Re-exported
// here so existing CLI/seed imports keep working unchanged.
export {
  DEFAULT_AGREEMENT_LABEL,
  DEFAULT_AGREEMENT_TITLE,
  DEFAULT_AGREEMENT_BODY,
} from '../shared/agreement-template';
