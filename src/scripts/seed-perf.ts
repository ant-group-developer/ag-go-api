/**
 * Seed a large volume of fake catalog data (categories, tags, folders, projects)
 * to check list performance and UI layout (long names, deep trees, pagination).
 *
 * Every seeded row has an id starting with `5eed000`, so the data can be removed
 * cleanly with --clean without touching real rows.
 *
 * Usage:
 *   yarn seed:perf                         # seed with default volume
 *   yarn seed:perf --projects 200000       # override any count
 *   yarn seed:perf --reset                 # remove previous seed data, then seed again
 *   yarn seed:perf --clean                 # only remove seed data
 *
 * Options:
 *   --categories <n>     Default 300.
 *   --tags <n>           Default 5000.
 *   --roots <n>          Root folders. Default 30.
 *   --branching <a,b,c>  Children per folder at each level below root. Default 6,5,4
 *                        (30 roots → 30 + 180 + 900 + 3600 = 4710 folders).
 *   --projects <n>       Default 50000.
 *   --max-tags <n>       Max tags per project. Default 8.
 *   --owner <userId>     Owner of projects/folders and the folder manager grant.
 *                        Default: the most common project owner / folder creator in the DB.
 *   --seed <n>           PRNG seed so runs are reproducible. Default 42.
 */
import 'dotenv/config';
import { Client } from 'pg';

const SEED_PREFIX = '5eed000';
const KIND = { category: 1, tag: 2, folder: 3, project: 4, grant: 5 } as const;
const CHUNK = 5000;

interface CliOptions {
  categories: number;
  tags: number;
  roots: number;
  branching: number[];
  projects: number;
  maxTags: number;
  owner: string | null;
  seed: number;
  clean: boolean;
  reset: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    categories: 300,
    tags: 5000,
    roots: 30,
    branching: [6, 5, 4],
    projects: 50000,
    maxTags: 8,
    owner: null,
    seed: 42,
    clean: false,
    reset: false,
  };
  const int = (flag: string, value: string | undefined) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} expects a non-negative integer`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--categories':
        opts.categories = int(arg, argv[++i]);
        break;
      case '--tags':
        opts.tags = int(arg, argv[++i]);
        break;
      case '--roots':
        opts.roots = int(arg, argv[++i]);
        break;
      case '--branching':
        opts.branching = (argv[++i] ?? '')
          .split(',')
          .filter(Boolean)
          .map((v) => int(arg, v));
        break;
      case '--projects':
        opts.projects = int(arg, argv[++i]);
        break;
      case '--max-tags':
        opts.maxTags = int(arg, argv[++i]);
        break;
      case '--owner':
        opts.owner = argv[++i] ?? null;
        break;
      case '--seed':
        opts.seed = int(arg, argv[++i]);
        break;
      case '--clean':
        opts.clean = true;
        break;
      case '--reset':
        opts.reset = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

// ---- helpers ----

function seedId(kind: number, index: number): string {
  const hex = index.toString(16).padStart(12, '0');
  return `${SEED_PREFIX}${kind}-0000-7000-8000-${hex}`;
}

/** mulberry32: small deterministic PRNG so the same --seed gives the same data. */
function createRandom(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const chance = (p: number) => next() < p;
  return { next, int, pick, chance };
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function normalizeTag(name: string) {
  return name.trim().toLocaleLowerCase('vi-VN');
}

async function bulkInsert(
  client: Client,
  table: string,
  columns: { name: string; type: string; expr?: string }[],
  rows: unknown[][],
  label: string,
) {
  const cols = columns.map((c) => c.name).join(', ');
  const unnestArgs = columns.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ');
  const aliases = columns.map((_, i) => `c${i}`).join(', ');
  const selects = columns
    .map((c, i) => (c.expr ? c.expr.replace('$', `c${i}`) : `c${i}`))
    .join(', ');
  const sql = `INSERT INTO ${table} (${cols}) SELECT ${selects} FROM unnest(${unnestArgs}) AS t(${aliases})`;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const params = columns.map((_, i) => chunk.map((row) => row[i]));
    await client.query(sql, params);
    process.stdout.write(`\r  ${label}: ${Math.min(start + CHUNK, rows.length)}/${rows.length}`);
  }
  if (rows.length) process.stdout.write('\n');
}

// ---- vocab ----

const CATEGORY_BASES = [
  'Ẩm thực',
  'Du lịch',
  'Kiến trúc',
  'Lễ hội',
  'Thiên nhiên',
  'Biển đảo',
  'Núi rừng',
  'Văn hóa',
  'Di tích lịch sử',
  'Làng nghề',
  'Đô thị',
  'Nông thôn',
  'Tâm linh',
  'Giao thông',
  'Thể thao',
  'Ẩm thực đường phố',
  'Nghỉ dưỡng',
  'Sự kiện',
  'Con người',
  'Động vật hoang dã',
  'Sông nước',
  'Chợ truyền thống',
  'Ẩm thực cung đình',
  'Nghệ thuật',
  'Hoàng hôn',
  'Bình minh',
  'Flycam',
  'Timelapse',
  'Phỏng vấn',
  'Quảng cáo',
  'Hậu trường',
  'Sản phẩm',
  'Nội thất',
  'Ngoại thất',
];
const CATEGORY_SUFFIXES = [
  'miền Bắc',
  'miền Trung',
  'miền Nam',
  'Tây Nguyên',
  'Tây Bắc',
  'đồng bằng sông Cửu Long',
  'mùa xuân',
  'mùa hè',
  'mùa thu',
  'mùa đông',
  'ban đêm',
  'cao cấp',
  'quốc tế',
];

const TAG_WORDS = [
  'phong cảnh',
  'drone',
  '4k',
  '8k',
  'hoàng hôn',
  'bình minh',
  'đêm',
  'mưa',
  'sương mù',
  'nắng',
  'chùa',
  'đền',
  'phố cổ',
  'biển',
  'núi',
  'hồ',
  'sông',
  'ruộng bậc thang',
  'cầu',
  'chợ',
  'thuyền',
  'xe máy',
  'ẩm thực',
  'phở',
  'bánh mì',
  'cà phê',
  'lễ hội',
  'áo dài',
  'nón lá',
  'đèn lồng',
  'trẻ em',
  'người già',
  'nông dân',
  'ngư dân',
  'du khách',
  'cận cảnh',
  'toàn cảnh',
  'slow motion',
  'timelapse',
  'hyperlapse',
  'gimbal',
  'handheld',
  'cinematic',
  'vertical',
  'b-roll',
  'interview',
];
const TAG_QUALIFIERS = [
  'đẹp',
  'đông người',
  'vắng',
  'cổ',
  'hiện đại',
  'xanh',
  'đỏ',
  'vàng',
  'trên cao',
  'góc thấp',
];

const FOLDER_ROOTS = [
  'Hà Nội',
  'Hồ Chí Minh',
  'Đà Nẵng',
  'Huế',
  'Hội An',
  'Ninh Bình',
  'Hạ Long',
  'Sa Pa',
  'Đà Lạt',
  'Nha Trang',
  'Phú Quốc',
  'Cần Thơ',
  'Hà Giang',
  'Mộc Châu',
  'Quy Nhơn',
  'Vũng Tàu',
  'Côn Đảo',
  'Mũi Né',
  'Cao Bằng',
  'Lạng Sơn',
  'Buôn Ma Thuột',
  'Pleiku',
  'Kon Tum',
  'Hải Phòng',
  'Nam Định',
  'Thanh Hóa',
  'Nghệ An',
  'Quảng Bình',
  'Quảng Ngãi',
  'Bến Tre',
  'An Giang',
  'Cà Mau',
  'Lào Cai',
];
const FOLDER_LEVEL_NAMES = [
  [
    'Dự án 2025',
    'Dự án 2026',
    'Khách hàng',
    'Nội bộ',
    'Lưu trữ',
    'Chiến dịch Tết',
    'Chiến dịch Hè',
    'Tư liệu',
  ],
  ['Quay ngày', 'Quay đêm', 'Flycam', 'Phỏng vấn', 'B-roll', 'Sự kiện', 'Hậu trường'],
  ['Đợt 1', 'Đợt 2', 'Đợt 3', 'Bản nháp', 'Bản final', 'Đã duyệt', 'Chờ duyệt'],
];

const PLACE_TYPES = [
  'Ga',
  'Chùa',
  'Đền',
  'Phố cổ',
  'Chợ',
  'Bãi biển',
  'Hồ',
  'Núi',
  'Cầu',
  'Bến thuyền',
  'Làng nghề',
  'Cổng chính',
  'Bảo tàng',
  'Quảng trường',
  'Công viên',
  'Nhà thờ',
  'Thác',
  'Hang',
  'Đảo',
  'Đồi chè',
];
const PLACE_NAMES = [
  'Hoa Lư',
  'Tràng An',
  'Bái Đính',
  'Tam Cốc',
  'Hoàn Kiếm',
  'Bến Thành',
  'Thiên Mụ',
  'Linh Ứng',
  'Sơn Trà',
  'Bà Nà',
  'Mỹ Khê',
  'An Bàng',
  'Long Biên',
  'Tây Hồ',
  'Trúc Bạch',
  'Fansipan',
  'Langbiang',
  'Xuân Hương',
  'Ponagar',
  'Kỳ Co',
  'Eo Gió',
  'Bản Giốc',
  'Mã Pì Lèng',
  'Mù Cang Chải',
];
const PROJECT_EXTRAS = [
  '',
  '',
  '',
  ' - bản quay lại',
  ' (góc rộng)',
  ' - mùa lễ hội',
  ' - khung giờ vàng',
  ' - tổng hợp tư liệu quay flycam, cận cảnh, toàn cảnh và phỏng vấn người dân địa phương trong nhiều ngày liên tiếp',
];
const DESCRIPTIONS = [
  null,
  null,
  'Tư liệu quay phục vụ dựng video quảng bá du lịch.',
  'Bộ footage gốc, chưa qua xử lý màu. Cần kiểm tra lại các clip bị rung trước khi render.',
  'Quay bằng drone và gimbal, độ phân giải 4K 60fps. Một số clip ban đêm có nhiễu, ưu tiên dùng clip ban ngày cho bản dựng chính. Liên hệ đội quay để lấy thêm góc máy nếu thiếu.',
];
const EVALUATION_STATUSES = [
  'draft',
  'pending',
  'completed',
  'partially_completed',
  'failed',
] as const;

// ---- main ----

async function clean(client: Client) {
  const like = `${SEED_PREFIX}%`;
  console.log('Removing previous seed data...');
  const foreignProjects = await client.query<{ n: string }>(
    `SELECT count(*) n FROM projects WHERE id::text NOT LIKE $1 AND folder_id::text LIKE $1`,
    [like],
  );
  const foreignFolders = await client.query<{ n: string }>(
    `SELECT count(*) n FROM folders WHERE id::text NOT LIKE $1 AND parent_id::text LIKE $1`,
    [like],
  );
  if (Number(foreignProjects.rows[0].n) || Number(foreignFolders.rows[0].n)) {
    throw new Error(
      `Seed folders contain ${foreignProjects.rows[0].n} real project(s) and ${foreignFolders.rows[0].n} real folder(s). ` +
        'Move them out of seed folders before cleaning.',
    );
  }
  const unlinkedTags = await client.query(
    `DELETE FROM project_tags WHERE tag_id::text LIKE $1 AND project_id::text NOT LIKE $1`,
    [like],
  );
  const unlinkedCategories = await client.query(
    `UPDATE projects SET category_id = NULL WHERE category_id::text LIKE $1 AND id::text NOT LIKE $1`,
    [like],
  );
  if (unlinkedTags.rowCount || unlinkedCategories.rowCount) {
    console.log(
      `  detached seed tags from ${unlinkedTags.rowCount} and seed categories from ${unlinkedCategories.rowCount} real project link(s)`,
    );
  }
  const projects = await client.query(`DELETE FROM projects WHERE id::text LIKE $1`, [like]);
  // Delete deepest folders first: parent_id is ON DELETE RESTRICT.
  let folders = 0;
  const depths = await client.query<{ depth: number }>(
    `SELECT DISTINCT depth FROM folders WHERE id::text LIKE $1 ORDER BY depth DESC`,
    [like],
  );
  for (const { depth } of depths.rows) {
    const res = await client.query(`DELETE FROM folders WHERE id::text LIKE $1 AND depth = $2`, [
      like,
      depth,
    ]);
    folders += res.rowCount ?? 0;
  }
  const tags = await client.query(`DELETE FROM tags WHERE id::text LIKE $1`, [like]);
  const categories = await client.query(`DELETE FROM categories WHERE id::text LIKE $1`, [like]);
  console.log(
    `  removed ${projects.rowCount} projects, ${folders} folders, ${tags.rowCount} tags, ${categories.rowCount} categories`,
  );
}

async function resolveOwner(client: Client, owner: string | null): Promise<string> {
  if (owner) return owner;
  const res = await client.query<{ user_id: string }>(
    `SELECT user_id FROM (
       SELECT owner_user_id AS user_id FROM projects WHERE id::text NOT LIKE $1
       UNION ALL
       SELECT created_by FROM folders WHERE id::text NOT LIKE $1
     ) u GROUP BY user_id ORDER BY count(*) DESC LIMIT 1`,
    [`${SEED_PREFIX}%`],
  );
  if (!res.rows[0])
    throw new Error('No existing user found in projects/folders. Pass --owner <userId>.');
  return res.rows[0].user_id;
}

async function seed(client: Client, opts: CliOptions) {
  const leftover = await client.query(`SELECT 1 FROM folders WHERE id::text LIKE $1 LIMIT 1`, [
    `${SEED_PREFIX}%`,
  ]);
  if (leftover.rowCount)
    throw new Error('Seed data already exists. Use --reset to replace it or --clean to remove it.');
  const rand = createRandom(opts.seed);
  const owner = await resolveOwner(client, opts.owner);
  console.log(`Owner user: ${owner}`);

  const existing = await client.query<{ kind: string; key: string }>(
    `SELECT 'cat_name' kind, lower(name) key FROM categories
     UNION ALL SELECT 'cat_slug', slug FROM categories
     UNION ALL SELECT 'tag', normalized_name FROM tags
     UNION ALL SELECT 'root', lower(name) FROM folders WHERE parent_id IS NULL`,
  );
  const taken = new Set(existing.rows.map((r) => `${r.kind}:${r.key}`));
  const now = Date.now();
  const randomPastDate = (maxDaysAgo: number) =>
    new Date(now - rand.next() * maxDaysAgo * 86_400_000);

  // Categories
  const categoryIds: string[] = [];
  const categoryRows: unknown[][] = [];
  for (let i = 0, attempt = 0; categoryIds.length < opts.categories; attempt++) {
    const base = CATEGORY_BASES[attempt % CATEGORY_BASES.length];
    const round = Math.floor(attempt / CATEGORY_BASES.length);
    const suffix =
      round === 0 ? '' : ` ${CATEGORY_SUFFIXES[(round - 1) % CATEGORY_SUFFIXES.length]}`;
    const cycle =
      round > CATEGORY_SUFFIXES.length ? ` ${Math.ceil(round / CATEGORY_SUFFIXES.length)}` : '';
    const name = `${base}${suffix}${cycle}`;
    const slug = slugify(name);
    if (taken.has(`cat_name:${name.toLowerCase()}`) || taken.has(`cat_slug:${slug}`)) continue;
    taken.add(`cat_name:${name.toLowerCase()}`).add(`cat_slug:${slug}`);
    const id = seedId(KIND.category, ++i);
    const createdAt = randomPastDate(720);
    categoryIds.push(id);
    categoryRows.push([
      id,
      name,
      slug,
      rand.chance(0.4) ? `Danh mục ${name.toLowerCase()} dùng để phân loại dự án.` : null,
      rand.int(0, 100),
      rand.chance(0.92),
      createdAt,
      createdAt,
    ]);
  }

  // Tags
  const tagIds: string[] = [];
  const tagRows: unknown[][] = [];
  for (let i = 0, attempt = 0; tagIds.length < opts.tags; attempt++) {
    const word = TAG_WORDS[attempt % TAG_WORDS.length];
    const round = Math.floor(attempt / TAG_WORDS.length);
    let name = word;
    if (round > 0) {
      const qualifier = TAG_QUALIFIERS[(round - 1) % TAG_QUALIFIERS.length];
      const cycle = Math.floor((round - 1) / TAG_QUALIFIERS.length);
      name = cycle === 0 ? `${word} ${qualifier}` : `${word} ${qualifier} ${cycle}`;
    }
    const normalized = normalizeTag(name);
    if (taken.has(`tag:${normalized}`)) continue;
    taken.add(`tag:${normalized}`);
    const id = seedId(KIND.tag, ++i);
    tagIds.push(id);
    tagRows.push([id, name, normalized, owner]);
  }

  // Folders (tree, breadth-first so parents are inserted before children)
  interface SeedFolder {
    id: string;
    name: string;
    pathKey: string;
    pathIds: string[];
    pathText: string;
    depth: number;
  }
  const folders: SeedFolder[] = [];
  let folderIndex = 0;
  let level: SeedFolder[] = [];
  for (let attempt = 0; level.length < opts.roots; attempt++) {
    const base = FOLDER_ROOTS[attempt % FOLDER_ROOTS.length];
    const round = Math.floor(attempt / FOLDER_ROOTS.length);
    const name = round === 0 ? base : `${base} ${round + 1}`;
    if (taken.has(`root:${name.toLowerCase()}`)) continue;
    taken.add(`root:${name.toLowerCase()}`);
    const id = seedId(KIND.folder, ++folderIndex);
    level.push({ id, name, pathKey: slugify(name), pathIds: [id], pathText: name, depth: 0 });
  }
  folders.push(...level);
  opts.branching.forEach((childCount, depthIndex) => {
    const names =
      FOLDER_LEVEL_NAMES[depthIndex] ?? FOLDER_LEVEL_NAMES[FOLDER_LEVEL_NAMES.length - 1];
    const next: SeedFolder[] = [];
    for (const parent of level) {
      for (let c = 0; c < childCount; c++) {
        const base = names[c % names.length];
        const name = c < names.length ? base : `${base} (${Math.floor(c / names.length) + 1})`;
        const id = seedId(KIND.folder, ++folderIndex);
        next.push({
          id,
          name,
          pathKey: `${parent.pathKey}/${slugify(name)}`,
          pathIds: [...parent.pathIds, id],
          pathText: `${parent.pathText} / ${name}`,
          depth: parent.depth + 1,
        });
      }
    }
    folders.push(...next);
    level = next;
  });

  const folderRows = folders.map((f, idx) => {
    const createdAt = randomPastDate(720);
    return [
      f.id,
      f.depth === 0 ? null : f.pathIds[f.pathIds.length - 2],
      f.name,
      f.pathKey,
      `{${f.pathIds.join(',')}}`,
      f.pathText,
      f.depth,
      idx % 10,
      true,
      owner,
      createdAt,
      createdAt,
    ];
  });
  const closureRows: unknown[][] = [];
  for (const f of folders) {
    f.pathIds.forEach((ancestor, i) =>
      closureRows.push([ancestor, f.id, f.pathIds.length - 1 - i]),
    );
  }
  let grantIndex = 0;
  const grantRows = folders.map((f) => [
    seedId(KIND.grant, ++grantIndex),
    f.id,
    'user',
    owner,
    'manager',
    true,
    owner,
  ]);

  // Projects: mostly uniform over all folders, plus a few hot folders with thousands of projects.
  const provinces = await client.query<{ id: string; country_id: string; code: string | null }>(
    `SELECT p.id, p.country_id, c.code FROM provinces p JOIN countries c ON c.id = p.country_id WHERE p.is_active`,
  );
  const vnProvinces = provinces.rows.filter((p) => p.code === 'VN');
  const provincePool = vnProvinces.length ? vnProvinces : provinces.rows;
  const countries = await client.query<{ id: string }>(`SELECT id FROM countries WHERE is_active`);
  const hotFolders = folders.slice(0, 3).map((f) => f.id);

  const projectRows: unknown[][] = [];
  const projectTagRows: unknown[][] = [];
  for (let i = 1; i <= opts.projects; i++) {
    const id = seedId(KIND.project, i);
    const folderId = rand.chance(0.1) ? rand.pick(hotFolders) : rand.pick(folders).id;
    const name =
      `${rand.int(1, 300)}. ${rand.pick(PLACE_TYPES)} ${rand.pick(PLACE_NAMES)}${rand.pick(PROJECT_EXTRAS)}`.slice(
        0,
        200,
      );
    let countryId: string | null = null;
    let provinceId: string | null = null;
    const geo = rand.next();
    if (geo < 0.7 && provincePool.length) {
      const province = rand.pick(provincePool);
      countryId = province.country_id;
      provinceId = province.id;
    } else if (geo < 0.8 && countries.rows.length) {
      countryId = rand.pick(countries.rows).id;
    }
    const status = rand.pick(EVALUATION_STATUSES);
    const imageCount = rand.chance(0.15) ? 0 : rand.int(0, 400);
    const videoCount = rand.chance(0.3) ? 0 : rand.int(0, 120);
    const originalBytes =
      imageCount * rand.int(2, 25) * 1_000_000 + videoCount * rand.int(50, 2000) * 1_000_000;
    const renderedBytes = status === 'draft' ? 0 : Math.floor(originalBytes * rand.next() * 0.4);
    const createdAt = randomPastDate(730);
    const updatedAt = new Date(createdAt.getTime() + rand.next() * (now - createdAt.getTime()));
    projectRows.push([
      id,
      owner,
      folderId,
      rand.chance(0.85) && categoryIds.length ? rand.pick(categoryIds) : null,
      countryId,
      provinceId,
      name,
      rand.pick(DESCRIPTIONS),
      status,
      imageCount + videoCount,
      imageCount,
      videoCount,
      originalBytes,
      renderedBytes,
      createdAt,
      updatedAt,
    ]);
    if (tagIds.length) {
      const tagCount = rand.int(0, opts.maxTags);
      const chosen = new Set<string>();
      while (chosen.size < Math.min(tagCount, tagIds.length)) {
        // Skew toward the first tags so a few popular tags have many projects.
        chosen.add(tagIds[Math.floor(Math.pow(rand.next(), 2) * tagIds.length)]);
      }
      for (const tagId of chosen) projectTagRows.push([id, tagId, createdAt]);
    }
  }

  console.log('Inserting...');
  await bulkInsert(
    client,
    'categories',
    [
      { name: 'id', type: 'uuid' },
      { name: 'name', type: 'text' },
      { name: 'slug', type: 'text' },
      { name: 'description', type: 'text' },
      { name: 'sort_order', type: 'int' },
      { name: 'is_active', type: 'bool' },
      { name: 'created_at', type: 'timestamptz' },
      { name: 'updated_at', type: 'timestamptz' },
    ],
    categoryRows,
    'categories',
  );
  await bulkInsert(
    client,
    'tags',
    [
      { name: 'id', type: 'uuid' },
      { name: 'name', type: 'text' },
      { name: 'normalized_name', type: 'text' },
      { name: 'created_by', type: 'text' },
    ],
    tagRows,
    'tags',
  );
  // Insert folders level by level so parent_id always points to an existing row.
  const maxDepth = Math.max(0, ...folders.map((f) => f.depth));
  for (let depth = 0; depth <= maxDepth; depth++) {
    await bulkInsert(
      client,
      'folders',
      [
        { name: 'id', type: 'uuid' },
        { name: 'parent_id', type: 'uuid' },
        { name: 'name', type: 'text' },
        { name: 'path_key', type: 'text' },
        { name: 'path_ids', type: 'text', expr: '$::uuid[]' },
        { name: 'path_text', type: 'text' },
        { name: 'depth', type: 'int' },
        { name: 'sort_order', type: 'int' },
        { name: 'is_active', type: 'bool' },
        { name: 'created_by', type: 'text' },
        { name: 'created_at', type: 'timestamptz' },
        { name: 'updated_at', type: 'timestamptz' },
      ],
      folderRows.filter((row) => row[6] === depth),
      `folders depth ${depth}`,
    );
  }
  await bulkInsert(
    client,
    'folder_closure',
    [
      { name: 'ancestor_id', type: 'uuid' },
      { name: 'descendant_id', type: 'uuid' },
      { name: 'depth', type: 'int' },
    ],
    closureRows,
    'folder_closure',
  );
  await bulkInsert(
    client,
    'access_grants',
    [
      { name: 'id', type: 'uuid' },
      { name: 'folder_id', type: 'uuid' },
      { name: 'principal_type', type: 'text' },
      { name: 'principal_id', type: 'text' },
      { name: 'access_level', type: 'text' },
      { name: 'inherit_children', type: 'bool' },
      { name: 'granted_by', type: 'text' },
    ],
    grantRows,
    'access_grants',
  );
  await bulkInsert(
    client,
    'projects',
    [
      { name: 'id', type: 'uuid' },
      { name: 'owner_user_id', type: 'text' },
      { name: 'folder_id', type: 'uuid' },
      { name: 'category_id', type: 'uuid' },
      { name: 'country_id', type: 'uuid' },
      { name: 'province_id', type: 'uuid' },
      { name: 'name', type: 'text' },
      { name: 'description', type: 'text' },
      { name: 'evaluation_status', type: 'text' },
      { name: 'media_count', type: 'int' },
      { name: 'image_count', type: 'int' },
      { name: 'video_count', type: 'int' },
      { name: 'original_bytes', type: 'int8' },
      { name: 'rendered_bytes', type: 'int8' },
      { name: 'created_at', type: 'timestamptz' },
      { name: 'updated_at', type: 'timestamptz' },
    ],
    projectRows,
    'projects',
  );
  await bulkInsert(
    client,
    'project_tags',
    [
      { name: 'project_id', type: 'uuid' },
      { name: 'tag_id', type: 'uuid' },
      { name: 'created_at', type: 'timestamptz' },
    ],
    projectTagRows,
    'project_tags',
  );

  console.log(
    `Seeded ${categoryRows.length} categories, ${tagRows.length} tags, ${folders.length} folders, ` +
      `${projectRows.length} projects, ${projectTagRows.length} project tags.`,
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (process.env.NODE_ENV === 'production')
    throw new Error('Refusing to seed fake data with NODE_ENV=production');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const started = Date.now();
  try {
    if (process.env.DATABASE_SCHEMA) {
      await client.query(
        `SET search_path TO ${client.escapeIdentifier(process.env.DATABASE_SCHEMA)}`,
      );
    }
    await client.query('BEGIN');
    if (opts.clean || opts.reset) await clean(client);
    if (!opts.clean) await seed(client, opts);
    await client.query('COMMIT');
    await client.query(
      'ANALYZE categories, tags, folders, folder_closure, access_grants, projects, project_tags',
    );
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
