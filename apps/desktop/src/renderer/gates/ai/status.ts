import type { AiStatus } from '../../../shared/entitlements.js';
import type { TurnError } from '../../../shared/assistant/types.js';
import { tr } from '../../i18n';
export function gateStatusForError(error: TurnError): AiStatus | null {
  return ['AI_ACCESS_REQUIRED', 'SIGN_IN_REQUIRED', 'ENTITLEMENT_UNAVAILABLE', 'HUMAN_CHECK_REQUIRED',
    'CONNECTION_REVOKED', 'AI_SERVICE_UNAVAILABLE', 'RATE_LIMITED', 'REVISION_CONFLICT', 'FEATURE_PAUSED', 'MAINTENANCE', 'UNSUPPORTED_VERSION'].includes(error.code) ? { status: 'denied', code: error.code as NonNullable<AiStatus['code']>,
    ...(error.retryAt ? { retryAt: error.retryAt } : {}) } : null;
}
export function aiRequestBlocked(state: AiStatus | null, now = Date.now()): boolean {
  if (state?.status === 'checking') return true;
  if (state?.status !== 'denied') return false;
  if (state.code === 'RATE_LIMITED') {
    const deadline = Date.parse(state.retryAt ?? '');
    return !Number.isFinite(deadline) || deadline > now;
  }
  return ['AI_ACCESS_REQUIRED', 'SIGN_IN_REQUIRED', 'ENTITLEMENT_UNAVAILABLE', 'HUMAN_CHECK_REQUIRED', 'CONNECTION_REVOKED'].includes(state.code ?? '');
}
/** inApp: the app's own assistant panel, which has no client to pair. */
export function aiStatusView(state: AiStatus, now = Date.now(), inApp = false) {
  if (state.status === 'ready') return { title: tr('gates_ai_status.ready'), message: '', recovery: null };
  if (state.status === 'checking') return { title: tr('gates_ai_status.checking_your_account'), message: '', recovery: null };
  if (state.status === 'off') return { title: tr('gates_ai_status.off'), message: tr('gates_ai_status.sign_in_and_open_a'), recovery: tr('gates_ai_status.retry_verification') };
  switch (state.code) {
    case 'AI_ACCESS_REQUIRED': return { title: tr('gates_ai_status.ai_not_available'), message: tr('gates_ai_status.ai_features_are_not_available'), recovery: tr('gates_ai_status.retry_verification') };
    // Also what a never-signed-in player sees: never "session ended".
    case 'SIGN_IN_REQUIRED': return { title: tr('gates_ai_status.sign_in_to_use_the'), message: tr('gates_ai_status.sign_in_to_use_ai'), recovery: tr('gates_ai_status.sign_in_to_path_of') };
    case 'HUMAN_CHECK_REQUIRED': return { title: tr('gates_ai_status.network_features_paused'), message: tr('gates_ai_status.complete_a_quick_check_to'), recovery: tr('gates_ai_status.continue_check') };
    case 'CONNECTION_REVOKED': return inApp ? { title: tr('gates_ai_status.assistant_stopped'), message: tr('gates_ai_status.the_assistant_lost_track_of'), recovery: tr('gates_ai_status.try_again') }
      : { title: tr('gates_ai_status.expired'), message: tr('gates_ai_status.this_connection_ended_pair_the'), recovery: tr('gates_ai_status.retry_verification') };
    case 'AI_SERVICE_UNAVAILABLE': return { title: tr('gates_ai_status.ai_service_unavailable'), message: tr('gates_ai_status.try_again_in_a_moment'), recovery: tr('gates_ai_status.retry_request') };
    case 'RATE_LIMITED': return { title: tr('gates_ai_status.keep_draft'), message: state.retryAt ? tr('gates_ai_status.try_again_at_tolocaletimestring', { toLocaleTimeString: new Date(state.retryAt).toLocaleTimeString() }) : tr('gates_ai_status.the_service_is_busy_keep'), recovery: aiRequestBlocked(state, now) ? null : tr('gates_ai_status.retry_request') };
    case 'REVISION_CONFLICT': return { title: tr('gates_ai_status.build_changed'), message: tr('gates_ai_status.this_build_changed_during_the'), recovery: tr('gates_ai_status.try_again') };
    case 'ENTITLEMENT_UNAVAILABLE': return { title: tr('gates_ai_status.can_t_reach_path_of'), message: tr('gates_ai_status.path_of_mastery_could_not'), recovery: tr('gates_ai_status.try_again') };
    case 'FEATURE_PAUSED': case 'MAINTENANCE': return { title: tr('gates_ai_status.assistant_paused'), message: tr('gates_ai_status.the_assistant_is_down_for'), recovery: tr('gates_ai_status.try_again') };
    case 'UNSUPPORTED_VERSION': return { title: tr('gates_ai_status.update_path_of_mastery'), message: tr('gates_ai_status.this_version_is_too_old'), recovery: null };
    default: return { title: tr('gates_ai_status.something_went_wrong'), message: tr('gates_ai_status.this_request_could_not_be'), recovery: tr('gates_ai_status.try_again') };
  }
}
