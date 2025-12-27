#!/usr/bin/env python3
"""
Show concrete examples of differences between the XML files
"""
import xml.etree.ElementTree as ET
from xml.dom import minidom

def pretty_print_xml(elem):
    """Convert element to pretty-printed string"""
    rough_string = ET.tostring(elem, encoding='unicode')
    reparsed = minidom.parseString(rough_string)
    return reparsed.toprettyxml(indent="  ")

def find_example_proof_errors(root):
    """Find examples of proof errors with context"""
    examples = []
    
    for para in root.iter():
        tag = para.tag.split('}')[-1]
        if tag == 'p':
            # Check if this paragraph has proof errors
            proof_errs = [e for e in para if e.tag.split('}')[-1] == 'proofErr']
            if proof_errs:
                # Get text from this paragraph
                texts = []
                for elem in para.iter():
                    if elem.tag.split('}')[-1] == 't' and elem.text:
                        texts.append(elem.text)
                
                if texts:
                    examples.append({
                        'proof_errors': len(proof_errs),
                        'text_preview': ' '.join(texts[:3])[:100],
                        'has_text': True
                    })
                    if len(examples) >= 3:
                        break
    
    return examples

def find_text_splitting_examples(texts1, texts2, start_idx=0, count=5):
    """Show examples of how text is split differently"""
    examples = []
    
    for i in range(start_idx, min(start_idx + count, len(texts1), len(texts2))):
        t1 = texts1[i]
        t2 = texts2[i]
        
        if t1['text'] != t2['text']:
            # Check surrounding context
            context1 = []
            context2 = []
            
            for j in range(max(0, i-2), min(len(texts1), i+3)):
                if j < len(texts1):
                    context1.append(texts1[j]['text'])
                if j < len(texts2):
                    context2.append(texts2[j]['text'])
            
            examples.append({
                'index': i,
                'original': t1['text'],
                'extracted': t2['text'],
                'context_original': '|'.join(context1),
                'context_extracted': '|'.join(context2)
            })
    
    return examples

def find_revision_id_differences(root1, root2):
    """Find examples of revision ID changes"""
    def get_rsids(root):
        rsids = []
        for elem in root.iter():
            rsid = elem.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}rsidRDefault')
            if rsid:
                tag = elem.tag.split('}')[-1]
                # Get text if available
                text = None
                for child in elem.iter():
                    if child.tag.split('}')[-1] == 't' and child.text:
                        text = child.text[:50]
                        break
                
                rsids.append({
                    'tag': tag,
                    'rsid': rsid,
                    'text': text
                })
        return rsids
    
    rsids1 = get_rsids(root1)
    rsids2 = get_rsids(root2)
    
    # Find differences
    differences = []
    min_len = min(len(rsids1), len(rsids2))
    
    for i in range(min_len):
        if rsids1[i]['rsid'] != rsids2[i]['rsid']:
            differences.append({
                'index': i,
                'original': rsids1[i],
                'extracted': rsids2[i]
            })
            if len(differences) >= 5:
                break
    
    return differences

# Load files
print("Loading XML files...")
with open('.cursor/document.xml', 'r', encoding='utf-8') as f:
    root1 = ET.fromstring(f.read())

with open('.cursor/document_extr.xml', 'r', encoding='utf-8') as f:
    root2 = ET.fromstring(f.read())

print("\n" + "="*70)
print("EXAMPLE 1: Proof Errors Added")
print("="*70)

proof_examples = find_example_proof_errors(root2)
for i, ex in enumerate(proof_examples, 1):
    print(f"\nProof Error Example {i}:")
    print(f"  Number of proof errors in paragraph: {ex['proof_errors']}")
    print(f"  Text context: {ex['text_preview']}...")

print("\n" + "="*70)
print("EXAMPLE 2: Text Content Modifications")
print("="*70)

# Extract text elements
def extract_text_elements(root):
    texts = []
    for elem in root.iter():
        if elem.tag.split('}')[-1] == 't':
            text = elem.text or ""
            if text.strip():
                texts.append({'text': text})
    return texts

texts1 = extract_text_elements(root1)
texts2 = extract_text_elements(root2)

# Find the specific example we saw
print("\nSpecific text modification example:")
for i in range(min(10, len(texts1), len(texts2))):
    if texts1[i]['text'] != texts2[i]['text']:
        print(f"\nText element {i}:")
        print(f"  Original:  {repr(texts1[i]['text'])}")
        print(f"  Extracted: {repr(texts2[i]['text'])}")
        
        # Show context
        print(f"\n  Context (elements {max(0,i-1)} to {min(len(texts1),i+2)}):")
        print(f"    Original:  {[repr(t['text'][:30]) for t in texts1[max(0,i-1):i+2]]}")
        print(f"    Extracted: {[repr(t['text'][:30]) for t in texts2[max(0,i-1):i+2]]}")
        break

print("\n" + "="*70)
print("EXAMPLE 3: Revision ID Changes")
print("="*70)

rsid_diffs = find_revision_id_differences(root1, root2)
if rsid_diffs:
    print(f"\nFound {len(rsid_diffs)} revision ID differences:")
    for diff in rsid_diffs[:3]:
        print(f"\n  Element {diff['index']}:")
        print(f"    Original rsidRDefault:  {diff['original']['rsid']}")
        print(f"    Extracted rsidRDefault: {diff['extracted']['rsid']}")
        if diff['original']['text']:
            print(f"    Text: {diff['original']['text'][:50]}")

print("\n" + "="*70)
print("EXAMPLE 4: Element Structure Differences")
print("="*70)

# Count runs in a specific paragraph
def count_runs_in_first_paragraph(root):
    """Count runs in the first paragraph"""
    for para in root.iter():
        if para.tag.split('}')[-1] == 'p':
            runs = [e for e in para if e.tag.split('}')[-1] == 'r']
            proof_errs = [e for e in para if e.tag.split('}')[-1] == 'proofErr']
            
            # Get text
            texts = []
            for elem in para.iter():
                if elem.tag.split('}')[-1] == 't' and elem.text:
                    texts.append(elem.text[:30])
            
            return {
                'runs': len(runs),
                'proof_errors': len(proof_errs),
                'text_preview': ' '.join(texts[:3])
            }
    return None

struct1 = count_runs_in_first_paragraph(root1)
struct2 = count_runs_in_first_paragraph(root2)

if struct1 and struct2:
    print("\nFirst paragraph structure comparison:")
    print(f"  Original:  {struct1['runs']} runs, {struct1['proof_errors']} proof errors")
    print(f"  Extracted: {struct2['runs']} runs, {struct2['proof_errors']} proof errors")
    print(f"\n  Text preview (original):  {struct1['text_preview']}")
    print(f"  Text preview (extracted): {struct2['text_preview']}")

print("\n" + "="*70)
print("SUMMARY OF KEY FINDINGS")
print("="*70)
print("""
1. PROOF ERRORS: The extracted file has 146 proof error elements that 
   weren't in the original. These are Word's grammar/spelling markers.

2. TEXT MODIFICATIONS: Some text content is changed:
   - "500 kV OVERHEAD LINES" → "500 kV OVERHEAD LINE"
   - Text reflow where characters are moved between elements

3. TEXT SPLITTING: Text is split into more elements (1,306 vs 1,186), 
   creating more granular <w:r> (run) elements.

4. REVISION IDs: Some revision tracking IDs are reset to '00000000', 
   indicating the parser is treating this as a new document state.

5. ELEMENT COUNT: More formatting elements overall, likely due to Word's
   normalization of the XML structure during processing.
""")






