import path from 'node:path';

export const fileTypeCategories = ['文档', '音频', '压缩包', '安装包', '其他'];
const extensions = new Map([
  ['文档', 'pdf doc docx xls xlsx ppt pptx txt md rtf csv tsv pages numbers key epub mobi odt ods odp html htm'],
  ['音频', 'mp3 wav aac m4a flac ogg opus aiff aif wma'],
  ['压缩包', 'zip rar 7z tar gz bz2 xz tgz zst'],
  ['安装包', 'dmg pkg app exe msi apk deb rpm iso']
].flatMap(([category, list]) => list.split(' ').map(extension => [`.${extension}`, category])));

// Only names/extensions are inspected. Nested ordinary files stay in their folders.
export function categoryForFile(name) {
  return extensions.get(path.extname(name).toLowerCase()) ?? '其他';
}
