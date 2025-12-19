#!/usr/bin/env python3
"""
Analyze specific differences in text splitting and proof errors
"""
import xml.etree.ElementTree as ET
from collections import defaultdict

def extract_all_text(root, preserve_structure=False):
    """Extract all text from w:t elements"""
    texts = []
    
    def extract_recursive(elem, path=""):
        tag = elem.tag.split('}')[-1]
        current_path = f"{path}/{tag}" if path else tag
        
        if tag == 't':
            text = elem.text or ""
            if text.strip():
                texts.append({
                    'text': text,
                    'path': current_path,
                    'parent': path,
                    'attrs': dict(elem.attrib)
                })
        
        for child in elem:
            extract_recursive(child, current_path)
    
    extract_recursive(root)
    return texts

def analyze_proof_errors(root):
    """Analyze proof error elements"""
    proof_errors = []
    
    for elem in root.iter():
        tag = elem.tag.split('}')[-1]
        if tag == 'proofErr':
            parent = elem.getparent() if hasattr(elem, 'getparent') else None
            proof_errors.append({
                'type': elem.get('w:type') or elem.get('type', 'unknown'),
                'attrs': dict(elem.attrib),
                'parent_tag': parent.tag.split('}')[-1] if parent else None
            })
    
    return proof_errors

def find_text_break_differences(texts1, texts2):
    """Find where text is broken differently"""
    # Concatenate all text
    full_text1 = ''.join(t['text'] for t in texts1)
    full_text2 = ''.join(t['text'] for t in texts2)
    
    # Find positions where text differs
    differences = []
    min_len = min(len(full_text1), len(full_text2))
    
    i = 0
    while i < min_len:
        if full_text1[i] != full_text2[i]:
            # Find the extent of the difference
            start = i
            end1 = start
            end2 = start
            
            # Find where they converge again
            while end1 < len(full_text1) and end2 < len(full_text2):
                if full_text1[end1] == full_text2[end2]:
                    break
                if end1 < len(full_text1) - 1:
                    end1 += 1
                if end2 < len(full_text2) - 1:
                    end2 += 1
                if end1 == len(full_text1) - 1 and end2 == len(full_text2) - 1:
                    break
                if full_text1[end1] == full_text2[end2]:
                    break
            
            # Try to find context
            context_start = max(0, start - 50)
            context_end = min(min_len, start + 100)
            
            differences.append({
                'position': start,
                'text1': full_text1[context_start:context_end],
                'text2': full_text2[context_start:context_end],
                'diff1': full_text1[start:end1+1][:50],
                'diff2': full_text2[start:end2+1][:50]
            })
            
            i = max(end1, end2)
        else:
            i += 1
        
        if len(differences) >= 10:  # Limit output
            break
    
    return differences

# Load files
print("Loading XML files...")
with open('.cursor/document.xml', 'r', encoding='utf-8') as f:
    xml1 = f.read()

with open('.cursor/document_extr.xml', 'r', encoding='utf-8') as f:
    xml2 = f.read()

root1 = ET.fromstring(xml1)
root2 = ET.fromstring(xml2)

print("\n=== TEXT ELEMENT ANALYSIS ===")
texts1 = extract_all_text(root1)
texts2 = extract_all_text(root2)

print(f"\nText elements in original: {len(texts1)}")
print(f"Text elements in extracted: {len(texts2)}")

# Compare total text length
full_text1 = ''.join(t['text'] for t in texts1)
full_text2 = ''.join(t['text'] for t in texts2)
print(f"\nTotal text length - original: {len(full_text1)}")
print(f"Total text length - extracted: {len(full_text2)}")
print(f"Length difference: {len(full_text2) - len(full_text1)}")

# Find where text elements differ
print("\n=== TEXT BREAKDOWN DIFFERENCES ===")
print("\nFirst 10 text elements from original:")
for i, t in enumerate(texts1[:10]):
    text_preview = t['text'][:60] + "..." if len(t['text']) > 60 else t['text']
    print(f"  {i+1}. [{len(t['text'])} chars] {text_preview}")

print("\nFirst 10 text elements from extracted:")
for i, t in enumerate(texts2[:10]):
    text_preview = t['text'][:60] + "..." if len(t['text']) > 60 else t['text']
    print(f"  {i+1}. [{len(t['text'])} chars] {text_preview}")

# Analyze proof errors
print("\n=== PROOF ERROR ANALYSIS ===")
proof_errs2 = analyze_proof_errors(root2)
print(f"\nProof errors found in extracted: {len(proof_errs2)}")

if proof_errs2:
    # Group by type
    by_type = defaultdict(int)
    for err in proof_errs2:
        err_type = err['type']
        by_type[err_type] += 1
    
    print("\nProof errors by type:")
    for err_type, count in sorted(by_type.items()):
        print(f"  {err_type}: {count}")
    
    print("\nSample proof error locations:")
    # Find parent context for proof errors
    def find_proof_error_contexts(root):
        contexts = []
        for parent in root.iter():
            for child in parent:
                tag = child.tag.split('}')[-1]
                if tag == 'proofErr':
                    # Try to find nearby text
                    nearby_text = None
                    for sibling in parent:
                        if sibling.tag.split('}')[-1] == 't' and sibling.text:
                            nearby_text = sibling.text[:50]
                            break
                    contexts.append({
                        'parent': parent.tag.split('}')[-1],
                        'nearby_text': nearby_text
                    })
                    if len(contexts) >= 5:
                        return contexts
        return contexts
    
    contexts = find_proof_error_contexts(root2)
    for i, ctx in enumerate(contexts):
        print(f"  {i+1}. Parent: {ctx['parent']}, Text: {ctx['nearby_text']}")

# Check for specific paragraph style differences
print("\n=== PARAGRAPH STYLE ATTRIBUTE COMPARISON ===")
def find_p_style_elements(root):
    """Find all paragraph style elements"""
    styles = []
    for elem in root.iter():
        tag = elem.tag.split('}')[-1]
        if tag == 'pStyle':
            parent = None
            for ancestor in root.iter():
                for child in ancestor:
                    if child == elem:
                        parent = ancestor.tag.split('}')[-1]
                        break
                if parent:
                    break
            styles.append({
                'val': elem.get('w:val') or elem.get('val'),
                'parent': parent,
                'all_attrs': dict(elem.attrib)
            })
    return styles

styles1 = find_p_style_elements(root1)
styles2 = find_p_style_elements(root2)

print(f"\nParagraph style elements - original: {len(styles1)}")
print(f"Paragraph style elements - extracted: {len(styles2)}")

# Compare values
vals1 = {s['val'] for s in styles1 if s['val']}
vals2 = {s['val'] for s in styles2 if s['val']}

if vals1 != vals2:
    print(f"\nStyle value differences:")
    print(f"  Only in original: {vals1 - vals2}")
    print(f"  Only in extracted: {vals2 - vals1}")

# Look for w:rsidRDefault differences (revision IDs)
print("\n=== REVISION ID COMPARISON ===")
def count_rsid_attributes(root):
    """Count rsidRDefault attributes"""
    rsids = []
    for elem in root.iter():
        tag = elem.tag.split('}')[-1]
        if tag in ['p', 'r', 'tbl', 'tr', 'tc']:
            rsid = elem.get('w:rsidRDefault') or elem.get('rsidRDefault')
            if rsid:
                rsids.append({
                    'tag': tag,
                    'rsid': rsid
                })
    return rsids

rsids1 = count_rsid_attributes(root1)
rsids2 = count_rsid_attributes(root2)

print(f"\nElements with rsidRDefault - original: {len(rsids1)}")
print(f"Elements with rsidRDefault - extracted: {len(rsids2)}")

# Compare unique rsids
unique_rsids1 = {r['rsid'] for r in rsids1}
unique_rsids2 = {r['rsid'] for r in rsids2}
print(f"\nUnique rsidRDefault values - original: {len(unique_rsids1)}")
print(f"Unique rsidRDefault values - extracted: {len(unique_rsids2)}")

if unique_rsids1 != unique_rsids2:
    print(f"  Only in original: {len(unique_rsids1 - unique_rsids2)}")
    print(f"  Only in extracted: {len(unique_rsids2 - unique_rsids1)}")

print("\n=== ANALYSIS COMPLETE ===")



