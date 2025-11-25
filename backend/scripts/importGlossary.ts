import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";
import * as path from "path";

const prisma = new PrismaClient();

async function main() {
  // Путь к файлу относительно ПАПКИ backend
  const filePath = path.join(__dirname, "..", "data", "glossary.xlsx");

  console.log("Reading glossary from:", filePath);

  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const entriesData: {
    sourceTerm: string;
    targetTerm: string;
    sourceLocale: string;
    targetLocale: string;
    direction: string;
    client: string | null;
    domain: string | null;
    isForbidden: boolean;
    notes: string | null;
    projectId: string | null;
  }[] = [];

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
        client: "KEGOC",
        domain: "technical",
        isForbidden: false,
        notes: null,
        projectId: null,
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
        client: "KEGOC",
        domain: "technical",
        isForbidden: false,
        notes: null,
        projectId: null,
      });
    }
  }

  if (!entriesData.length) {
    console.log("No entries found in Excel. Nothing to import.");
    return;
  }

  console.log("Importing entries:", entriesData.length);

  // createMany быстрее, чем куча create
  const result = await prisma.glossaryEntry.createMany({
    data: entriesData,
    skipDuplicates: true, // на случай повторов
  });

  console.log("Imported (created) entries:", result.count);
}

main()
  .catch((err) => {
    console.error("Import failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
