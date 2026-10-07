/** Time zone the download timestamp in archive names is written in. */
const DOWNLOAD_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const timestampFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: DOWNLOAD_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** `YYYYMMddHHmmss` in Vietnam time, e.g. `20261007143005`. */
export function formatDownloadTimestamp(value: Date): string {
  const parts = Object.fromEntries(
    timestampFormat.formatToParts(value).map((part) => [part.type, part.value]),
  );
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

/**
 * Makes a name safe as one path segment on Windows, macOS and Linux: characters those systems
 * reject and control characters become `_`, and runs of whitespace collapse. Vietnamese letters
 * are kept.
 */
export function sanitizeFilename(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

/** `[Folder] - [Project]`, the name of a project's folder inside a multi-project archive. */
export function projectFolderName(folderName: string | null | undefined, projectName: string) {
  return sanitizeFilename([folderName?.trim(), projectName.trim()].filter(Boolean).join(' - '));
}

/**
 * The saved archive's file name:
 * - one project: `[Folder] - [Project] - [YYYYMMddHHmmss].zip`
 * - several: `Dự án (N) - [YYYYMMddHHmmss].zip`
 */
export function downloadZipFilename(
  projects: Array<{ name: string; folderName?: string | null }>,
  createdAt: Date,
  fallback: string,
): string {
  const timestamp = formatDownloadTimestamp(createdAt);
  if (projects.length === 1) {
    const base = projectFolderName(projects[0].folderName, projects[0].name);
    return `${base || fallback} - ${timestamp}.zip`;
  }
  if (projects.length > 1) {
    return `Dự án (${projects.length}) - ${timestamp}.zip`;
  }
  return `${fallback} - ${timestamp}.zip`;
}

/**
 * Hands out archive entry names, numbering repeats within the same folder the way file
 * managers do: `a.jpg`, `a (2).jpg`, `a (3).jpg`.
 */
export class ZipEntryNamer {
  private readonly used = new Set<string>();

  next(folder: string | null, filename: string): string {
    const safe = sanitizeFilename(filename) || 'file';
    const dot = safe.lastIndexOf('.');
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const extension = dot > 0 ? safe.slice(dot) : '';
    const prefix = folder ? `${folder}/` : '';
    let candidate = `${prefix}${safe}`;
    for (let index = 2; this.used.has(candidate.toLocaleLowerCase('vi-VN')); index += 1) {
      candidate = `${prefix}${stem} (${index})${extension}`;
    }
    this.used.add(candidate.toLocaleLowerCase('vi-VN'));
    return candidate;
  }
}
