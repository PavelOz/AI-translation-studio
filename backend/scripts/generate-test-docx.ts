/**
 * Script to generate a test DOCX file with Russian segments for testing hybrid/vector search
 */

import JSZip from 'jszip';
import * as fs from 'fs/promises';
import * as path from 'path';

// Sample Russian text segments that are likely to match entries in TM
// These are based on common technical/business phrases
const testSegments = [
  'В отчетном году частота в ЕЭС Казахстана стабильно поддерживалась на уровне 50 Гц.',
  'Проект был определен как Проект Категории "A" согласно',
  'Политика Гарантии Банка',
  'Все природоохранные мероприятия, которые должны быть выполнены',
  'Естественные ареалы обитания: район реализации проекта',
  'Социальные аспекты:',
  'Проект влечет за собой отвод земель и связанные с',
  'Ниже будут указаны и обсуждены политики гарантии банка',
  'АО "KEGOC" в рамках реализации проекта уже разработа',
  'Выбросы шума и выхлопных газов будут минимизированы',
  'Дать информацию кратко о количестве землепользователей',
  'Проект влечет за собой отвод земель и связанные с этим мероприятия',
];

async function generateTestDocx() {
  console.log('📝 Generating test DOCX file...\n');

  // Create a minimal DOCX structure
  const zip = new JSZip();

  // Create [Content_Types].xml
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  // Create document.xml with paragraphs
  const paragraphs = testSegments
    .map(
      (text) => `
    <w:p>
      <w:r>
        <w:t xml:space="preserve">${escapeXml(text)}</w:t>
      </w:r>
    </w:p>`,
    )
    .join('');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs}
    <w:p>
      <w:r>
        <w:t xml:space="preserve"></w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`;

  // Create _rels/.rels
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  // Create word/_rels/document.xml.rels
  const wordRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;

  // Create word/styles.xml (minimal)
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
</w:styles>`;

  // Create word/settings.xml (minimal)
  const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
</w:settings>`;

  // Create word/webSettings.xml (minimal)
  const webSettings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:webSettings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
</w:webSettings>`;

  // Create word/fontTable.xml (minimal)
  const fontTable = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:font w:name="Times New Roman">
    <w:panose1 w:val="02020603050405020304"/>
  </w:font>
</w:fonts>`;

  // Create word/numbering.xml (minimal)
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
</w:numbering>`;

  // Create word/theme/theme1.xml (minimal)
  const theme = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
  <a:themeElements>
    <a:clrScheme name="Office"/>
  </a:themeElements>
</a:theme>`;

  // Add files to zip
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('word/document.xml', documentXml);
  zip.file('word/_rels/document.xml.rels', wordRels);
  zip.file('word/styles.xml', styles);
  zip.file('word/settings.xml', settings);
  zip.file('word/webSettings.xml', webSettings);
  zip.file('word/fontTable.xml', fontTable);
  zip.file('word/numbering.xml', numbering);
  zip.file('word/theme/theme1.xml', theme);

  // Generate the DOCX file
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  // Save to file
  const outputPath = path.join(__dirname, '..', 'test-vector-search.docx');
  await fs.writeFile(outputPath, buffer);

  console.log(`✅ Test DOCX file created: ${outputPath}`);
  console.log(`\n📊 File contains ${testSegments.length} segments:`);
  testSegments.forEach((seg, i) => {
    console.log(`   ${i + 1}. ${seg.substring(0, 60)}${seg.length > 60 ? '...' : ''}`);
  });
  console.log('\n💡 Upload this file to your project to test hybrid/vector search!');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

generateTestDocx().catch((error) => {
  console.error('❌ Error generating test DOCX:', error);
  process.exit(1);
});



