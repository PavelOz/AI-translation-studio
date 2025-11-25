import { prisma } from "../db/prisma";
import * as XLSX from "xlsx";

export interface ImportGlossaryOptions {
  filePath: string;
  projectId?: string | null;
  client?: string | null;
  defaultDomain?: string | null;
}

export async function importGlossaryFromExcel(options: ImportGlossaryOptions) {
  const { filePath, projectId = null, client = "KEGOC", defaultDomain = null } = options;

  // 1. Load Excel
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // 2. Parse rows
  const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const entriesData = [];

  for (const row of rows) {
    const ru = String(row["Название"] || "").trim();
    const kk = String(row["Перевод на казахский"] || "").trim();
    const en = String(row["ENG"] || "").trim();

    if (!ru) continue;

    // ru → en
    if (en) {
      entriesData.push({
        sourceTerm: ru,
        targetTerm: en,
        sourceLocale: "ru",
        targetLocale: "en",
        direction: "ru→en",
        client,
        domain: defaultDomain,
        isForbidden: false,
        notes: null,
        projectId,
      });
    }

    // ru → kk
    if (kk) {
      entriesData.push({
        sourceTerm: ru,
        targetTerm: kk,
        sourceLocale: "ru",
        targetLocale: "kk",
        direction: "ru→kk",
        client,
        domain: defaultDomain,
        isForbidden: false,
        notes: null,
        projectId,
      });
    }
  }

  if (!entriesData.length) {
    return { imported: 0 };
  }

  // 3. Write to DB
  const created = await prisma.$transaction(
    entriesData.map((data) => prisma.glossaryEntry.create({ data }))
  );

  return { imported: created.length };
}
