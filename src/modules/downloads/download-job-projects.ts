import type { DataSource } from 'typeorm';

export type DownloadJobProject = { projectId: string; name: string; folderName: string | null };

/**
 * The project (and its folder's own name) of every item of a download job, keyed by
 * `project_media_id`, in the order the projects were first added.
 */
export async function loadDownloadJobProjects(
  dataSource: DataSource,
  downloadJobId: string,
): Promise<Map<string, DownloadJobProject>> {
  const rows = (await dataSource.query(
    `SELECT item.project_media_id AS "projectMediaId",
            project.id AS "projectId",
            project.name AS "name",
            folder.name AS "folderName"
     FROM download_job_items item
     INNER JOIN project_media media ON media.id = item.project_media_id
     INNER JOIN projects project ON project.id = media.project_id
     LEFT JOIN folders folder ON folder.id = project.folder_id
     WHERE item.download_job_id = $1
     ORDER BY item.created_at ASC, item.id ASC`,
    [downloadJobId],
  )) as Array<DownloadJobProject & { projectMediaId: string }>;
  return new Map(rows.map(({ projectMediaId, ...project }) => [projectMediaId, project] as const));
}

/** Distinct projects of a job, in first-seen order. */
export function distinctProjects(byMedia: Map<string, DownloadJobProject>): DownloadJobProject[] {
  const projects = new Map<string, DownloadJobProject>();
  for (const project of byMedia.values()) {
    if (!projects.has(project.projectId)) {
      projects.set(project.projectId, project);
    }
  }
  return [...projects.values()];
}
