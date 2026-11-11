// Texts of native Electron dialogs and notifications. Main has no i18n, so the few fixed strings live here, one line per language.
// Dynamic notification bodies (price alerts) stay English: they are built from live data and have no fixed text to look up.
import type { LanguageCode } from '../shared/library.js';

type Row = Record<LanguageCode, string>;
const row = (en: string, de: string, es: string, fr: string, ja: string, ko: string, ptBR: string, ru: string, th: string): Row => ({ en, de, es, fr, ja, ko, 'pt-BR': ptBR, ru, th });

const T = {
  run_open: row('A Run is open.', 'Ein Run ist geöffnet.', 'Hay un Run abierto.', 'Un Run est ouvert.', 'Runが開いています。', '런이 열려 있습니다.', 'Há uma Run aberta.', 'Открыт забег (Run).', 'มี Run เปิดอยู่'),
  run_detail: row('Keep the Run window open, or close both windows? Run progress is saved either way.',
    'Run-Fenster offen lassen oder beide Fenster schließen? Der Fortschritt des Runs wird in beiden Fällen gespeichert.',
    '¿Mantener abierta la ventana del Run o cerrar ambas ventanas? El progreso del Run se guarda en ambos casos.',
    'Garder la fenêtre du Run ouverte ou fermer les deux fenêtres ? La progression du Run est enregistrée dans les deux cas.',
    'Runのウィンドウを開いたままにしますか、それとも両方のウィンドウを閉じますか？どちらでもRunの進行状況は保存されます。',
    '런 창을 열어 둘까요, 아니면 두 창을 모두 닫을까요? 어느 쪽이든 런 진행 상황은 저장됩니다.',
    'Manter a janela da Run aberta ou fechar as duas janelas? O progresso da Run é salvo nos dois casos.',
    'Оставить окно забега открытым или закрыть оба окна? Прогресс забега сохраняется в обоих случаях.',
    'จะเปิดหน้าต่าง Run ไว้ หรือปิดทั้งสองหน้าต่าง? ความคืบหน้าของ Run จะถูกบันทึกไว้ไม่ว่าจะเลือกแบบใด'),
  run_keep: row('Keep Run open', 'Run offen lassen', 'Mantener Run abierto', 'Garder le Run ouvert', 'Runを開いたままにする', '런 열어 두기', 'Manter Run aberta', 'Оставить забег открытым', 'เปิด Run ไว้'),
  run_both: row('Close both', 'Beide schließen', 'Cerrar ambas', 'Tout fermer', '両方閉じる', '모두 닫기', 'Fechar as duas', 'Закрыть оба', 'ปิดทั้งสอง'),
  cancel: row('Cancel', 'Abbrechen', 'Cancelar', 'Annuler', 'キャンセル', '취소', 'Cancelar', 'Отмена', 'ยกเลิก'),
  builds_dir: row('Where should builds be saved?', 'Wo sollen Builds gespeichert werden?', '¿Dónde se guardarán las builds?', 'Où enregistrer les builds ?', 'ビルドの保存先を選択してください', '빌드를 어디에 저장할까요?', 'Onde as builds devem ser salvas?', 'Где сохранять билды?', 'จะบันทึกบิลด์ไว้ที่ไหน?'),
  open_build: row('Open a build file', 'Build-Datei öffnen', 'Abrir un archivo de build', 'Ouvrir un fichier de build', 'ビルドファイルを開く', '빌드 파일 열기', 'Abrir um arquivo de build', 'Открыть файл билда', 'เปิดไฟล์บิลด์'),
  save_build: row('Save build file', 'Build-Datei speichern', 'Guardar archivo de build', 'Enregistrer le fichier de build', 'ビルドファイルを保存', '빌드 파일 저장', 'Salvar arquivo de build', 'Сохранить файл билда', 'บันทึกไฟล์บิลด์'),
  all_files: row('All files', 'Alle Dateien', 'Todos los archivos', 'Tous les fichiers', 'すべてのファイル', '모든 파일', 'Todos os arquivos', 'Все файлы', 'ไฟล์ทั้งหมด'),
  lf_game_folder: row('Choose the Path of Exile folder', 'Path-of-Exile-Ordner auswählen', 'Elige la carpeta de Path of Exile', 'Choisir le dossier de Path of Exile', 'Path of Exileのフォルダを選択', 'Path of Exile 폴더 선택', 'Escolha a pasta do Path of Exile', 'Выберите папку Path of Exile', 'เลือกโฟลเดอร์ Path of Exile'),
  lf_open: row('Open a loot filter', 'Beutefilter öffnen', 'Abrir un filtro de botín', 'Ouvrir un filtre de butin', 'ルートフィルターを開く', '전리품 필터 열기', 'Abrir um filtro de loot', 'Открыть фильтр добычи', 'เปิดฟิลเตอร์ไอเทม'),
  lf_open_files: row('Item filters, rule packs and recovery files', 'Itemfilter, Regelpakete und Wiederherstellungsdateien', 'Filtros de objetos, paquetes de reglas y archivos de recuperación', "Filtres d'objets, packs de règles et fichiers de récupération", 'アイテムフィルター、ルールパック、復元ファイル', '아이템 필터, 규칙 팩, 복구 파일', 'Filtros de itens, pacotes de regras e arquivos de recuperação', 'Фильтры предметов, наборы правил и файлы восстановления', 'ฟิลเตอร์ไอเทม ชุดกฎ และไฟล์กู้คืน'),
  lf_save_pack: row('Save a rule pack', 'Regelpaket speichern', 'Guardar un paquete de reglas', 'Enregistrer un pack de règles', 'ルールパックを保存', '규칙 팩 저장', 'Salvar um pacote de regras', 'Сохранить набор правил', 'บันทึกชุดกฎ'),
  lf_export_recovery: row('Export recovery file', 'Wiederherstellungsdatei exportieren', 'Exportar archivo de recuperación', 'Exporter le fichier de récupération', '復元ファイルをエクスポート', '복구 파일 내보내기', 'Exportar arquivo de recuperação', 'Экспортировать файл восстановления', 'ส่งออกไฟล์กู้คืน'),
  lf_save_copy: row('Save a copy of the filter', 'Kopie des Filters speichern', 'Guardar una copia del filtro', 'Enregistrer une copie du filtre', 'フィルターのコピーを保存', '필터 사본 저장', 'Salvar uma cópia do filtro', 'Сохранить копию фильтра', 'บันทึกสำเนาของฟิลเตอร์'),
  lf_rule_packs: row('Rule packs', 'Regelpakete', 'Paquetes de reglas', 'Packs de règles', 'ルールパック', '규칙 팩', 'Pacotes de regras', 'Наборы правил', 'ชุดกฎ'),
  lf_recovery: row('Loot filter recovery file', 'Wiederherstellungsdatei des Beutefilters', 'Archivo de recuperación del filtro de botín', 'Fichier de récupération du filtre de butin', 'ルートフィルターの復元ファイル', '전리품 필터 복구 파일', 'Arquivo de recuperação do filtro de loot', 'Файл восстановления фильтра добычи', 'ไฟล์กู้คืนฟิลเตอร์ไอเทม'),
  lf_filters: row('Item filters', 'Itemfilter', 'Filtros de objetos', "Filtres d'objets", 'アイテムフィルター', '아이템 필터', 'Filtros de itens', 'Фильтры предметов', 'ฟิลเตอร์ไอเทม'),
  lf_sound: row('Choose the sound to use as {{name}}', 'Sound auswählen, der als {{name}} verwendet werden soll', 'Elige el sonido que se usará como {{name}}', 'Choisir le son à utiliser comme {{name}}', '{{name}}として使うサウンドを選択', '{{name}}(으)로 사용할 소리 선택', 'Escolha o som a usar como {{name}}', 'Выберите звук для {{name}}', 'เลือกเสียงที่จะใช้เป็น {{name}}'),
  lf_sounds: row('Sounds', 'Sounds', 'Sonidos', 'Sons', 'サウンド', '소리', 'Sons', 'Звуки', 'เสียง'),
  lf_pick_log: row('Choose the Client.txt log of Path of Exile', 'Client.txt-Log von Path of Exile auswählen', 'Elige el registro Client.txt de Path of Exile', 'Choisir le journal Client.txt de Path of Exile', 'Path of ExileのClient.txtログを選択', 'Path of Exile의 Client.txt 로그 선택', 'Escolha o log Client.txt do Path of Exile', 'Выберите журнал Client.txt Path of Exile', 'เลือกล็อก Client.txt ของ Path of Exile'),
  export_stash: row('Export stash', 'Lager exportieren', 'Exportar alijo', 'Exporter le coffre', '倉庫をエクスポート', '보관함 내보내기', 'Exportar baú', 'Экспортировать тайник', 'ส่งออกคลัง'),
  teleporting: row('Teleporting', 'Teleportiere', 'Teletransportando', 'Téléportation', 'テレポート中', '텔레포트 중', 'Teletransportando', 'Телепортация', 'กำลังเทเลพอร์ต'),
  teleport_failed: row('Could not teleport', 'Teleport fehlgeschlagen', 'No se pudo teletransportar', 'Téléportation impossible', 'テレポートできませんでした', '텔레포트하지 못했습니다', 'Não foi possível teletransportar', 'Не удалось телепортироваться', 'เทเลพอร์ตไม่สำเร็จ'),
} satisfies Record<string, Row>;

export type MainTextId = keyof typeof T;

let lang: LanguageCode = 'en';
const NAMES: Record<string, LanguageCode> = { de: 'de', es: 'es', fr: 'fr', ja: 'ja', ko: 'ko', ru: 'ru', th: 'th' };

/** The app language from Settings ('system' follows the OS locale, as the renderer does). */
export function setMainLanguage(setting: string, osLocale: string): void {
  const l = (setting === 'system' ? osLocale : setting).toLowerCase();
  lang = l.startsWith('pt') ? 'pt-BR' : NAMES[l.slice(0, 2)] ?? 'en';
}

export function mt(id: MainTextId, vars?: Record<string, string>): string {
  const s = T[id][lang] ?? T[id].en;
  return vars ? s.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '') : s;
}
