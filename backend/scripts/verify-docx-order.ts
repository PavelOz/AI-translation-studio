/**
 * Verification script to test DOCX order preservation
 * 
 * This script creates a mock DOCX XML with mixed content (Para 1, Table 1, Para 2)
 * and verifies that segments are extracted in the correct order.
 * 
 * Expected order: Para 1 -> Table 1 -> Para 2
 * Current bug: Para 1 -> Para 2 -> Table 1 (if not fixed)
 */

import { XMLParser } from 'fast-xml-parser';
import { DocxHandler } from '../src/utils/file-handlers/docx.handler';
import JSZip from 'jszip';

// Mock DOCX XML with mixed content: Para 1, Table 1, Para 2
const mockDocumentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:t>Para 1</w:t>
      </w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc>
          <w:p>
            <w:r>
              <w:t>Table 1 Cell 1</w:t>
            </w:r>
          </w:p>
        </w:tc>
        <w:tc>
          <w:p>
            <w:r>
              <w:t>Table 1 Cell 2</w:t>
            </w:r>
          </w:p>
        </w:tc>
      </w:tr>
    </w:tbl>
    <w:p>
      <w:r>
        <w:t>Para 2</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`;

async function createMockDocx(): Promise<Buffer> {
  const zip = new JSZip();
  
  // Create minimal DOCX structure
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('word/document.xml', mockDocumentXml);

  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

async function testOrderPreservation() {
  console.log('🧪 Testing DOCX order preservation...\n');

  // Create mock DOCX
  const mockDocx = await createMockDocx();
  
  // Test with DocxHandler
  const handler = new DocxHandler();
  
  try {
    const result = await handler.parse(mockDocx);
    
    console.log('📊 Extracted segments:');
    result.segments.forEach((seg, idx) => {
      console.log(`  ${idx + 1}. [${seg.type}] ${seg.sourceText}`);
    });
    
    console.log('\n🔍 Verifying order...\n');
    
    // Expected order: Para 1 -> Table 1 (Cell 1) -> Table 1 (Cell 2) -> Para 2
    const expectedOrder = [
      { type: 'paragraph', text: 'Para 1' },
      { type: 'table-cell', text: 'Table 1 Cell 1' },
      { type: 'table-cell', text: 'Table 1 Cell 2' },
      { type: 'paragraph', text: 'Para 2' },
    ];
    
    let allPassed = true;
    
    if (result.segments.length !== expectedOrder.length) {
      console.error(`❌ FAIL: Expected ${expectedOrder.length} segments, got ${result.segments.length}`);
      allPassed = false;
    } else {
      for (let i = 0; i < expectedOrder.length; i++) {
        const expected = expectedOrder[i];
        const actual = result.segments[i];
        
        const typeMatch = actual.type === expected.type;
        const textMatch = actual.sourceText.trim() === expected.text;
        
        if (typeMatch && textMatch) {
          console.log(`✅ Segment ${i + 1}: Correct (${actual.type}: "${actual.sourceText}")`);
        } else {
          console.error(`❌ Segment ${i + 1}: Mismatch`);
          console.error(`   Expected: ${expected.type}: "${expected.text}"`);
          console.error(`   Got:      ${actual.type}: "${actual.sourceText}"`);
          allPassed = false;
        }
      }
    }
    
    console.log('\n' + '='.repeat(60));
    if (allPassed) {
      console.log('✅ TEST PASSED: Order is preserved correctly!');
      console.log('   Para 1 -> Table 1 -> Para 2');
    } else {
      console.log('❌ TEST FAILED: Order is NOT preserved correctly!');
      console.log('   Expected: Para 1 -> Table 1 -> Para 2');
      console.log('   This indicates the bug is still present.');
    }
    console.log('='.repeat(60));
    
    // Also test the XML parser structure
    console.log('\n🔬 Testing XML parser structure with preserveOrder...\n');
    const parser = new XMLParser({ 
      ignoreAttributes: false, 
      attributeNamePrefix: '@_', 
      preserveOrder: true,
      trimValues: false,
    });
    
    const parsed = parser.parse(mockDocumentXml);
    console.log('Parsed structure (first level):');
    console.log(JSON.stringify(Object.keys(parsed), null, 2));
    
    if (parsed['w:document']) {
      console.log('\nDocument structure:');
      console.log(JSON.stringify(Object.keys(parsed['w:document']), null, 2));
      
      if (Array.isArray(parsed['w:document'])) {
        console.log('\nDocument is an array (preserveOrder enabled)');
        const doc = parsed['w:document'][0];
        if (doc && doc['w:body']) {
          const body = doc['w:body'];
          if (Array.isArray(body)) {
            console.log(`Body is an array with ${body.length} element(s)`);
            const bodyObj = body[0];
            if (bodyObj && bodyObj['w:body']) {
              const children = bodyObj['w:body'];
              if (Array.isArray(children)) {
                console.log(`Body children array has ${children.length} element(s)`);
                children.forEach((child, idx) => {
                  const keys = Object.keys(child);
                  console.log(`  ${idx + 1}. ${keys.join(', ')}`);
                });
              }
            }
          }
        }
      }
    }
    
    return allPassed;
  } catch (error) {
    console.error('❌ Error during parsing:', error);
    if (error instanceof Error) {
      console.error('   Message:', error.message);
      console.error('   Stack:', error.stack);
    }
    return false;
  }
}

// Run the test
testOrderPreservation()
  .then((passed) => {
    process.exit(passed ? 0 : 1);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });




