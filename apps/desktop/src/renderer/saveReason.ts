import { tr } from './i18n';
// Plain words for a failed build save. The library store's own messages are already plain ("That build file is gone.");
// a failed write carries Node's raw error ("Could not write X.xml: EPERM: operation not permitted, rename '...tmp' -> '...'"),
// which names a temp file and an errno. Those become one sentence here; the raw text stays for the Details disclosure.
const PLAIN: Record<string, string> = {
  EPERM: tr('saveReason.the_file_is_read_only'),
  EACCES: tr('saveReason.the_file_is_read_only'),
  EBUSY: tr('saveReason.the_file_is_read_only'),
  EROFS: tr('saveReason.the_drive_is_read_only'),
  ENOSPC: tr('saveReason.the_disk_is_full'),
  EDQUOT: tr('saveReason.the_disk_is_full'),
  ENOENT: tr('saveReason.the_builds_folder_could_not'),
};

export function plainSaveReason(raw: string): string {
  const code = /\b(E[A-Z]{2,}):/.exec(raw)?.[1];
  if (code) return PLAIN[code] ?? tr('saveReason.the_file_could_not_be');
  return /^Could not write\b/.test(raw) ? tr('saveReason.the_file_could_not_be') : raw;
}
