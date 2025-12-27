#!/usr/bin/env python3
"""
Detailed comparison of text content between the two files
"""
import xml.etree.ElementTree as ET
import re

def extract_text_with_context(root, max_examples=20):
    """Extract text with surrounding context"""
    texts = []
    path_stack = []
    
    def extract_recursive(elem, depth=0):
        tag = elem.tag.split('}')[-1]
        path_stack.append(tag)
        path = '/'.join(path_stack[-5:])  # Last 5 levels
        
        if tag == 't':
            text = elem.text or ""
            if text.strip():
                # Get parent attributes
                parent = path_stack[-2] if len(path_stack) > 1 else None
                texts.append({
                    'text': text,
                    'path': path,
                    'parent': parent,
                    'full_path': '/'.join(path_stack)
                })
        
        for child in elem:
            extract_recursive(child, depth + 1)
        
        path_stack.pop()
    
    extract_recursive(root)
    return texts

def find_text_additions(texts1, texts2):
    """Find text that appears in extracted but not in original"""
    # Build a map of text chunks from original
    text_map1 = {}
    for i, t in enumerate(texts1):
        key = t['text'][:50]  # Use first 50 chars as key
        if key not in text_map1:
            text_map1[key] = []
        text_map1[key].append((i, t))
    
    # Find texts in extracted that don't match
    additions = []
    for i, t in enumerate(texts2):
        key = t['text'][:50]
        if key not in text_map1:
            additions.append(t)
        elif not any(abs(len(t['text']) - len(t1['text'])) < 5 for _, t1 in text_map1[key]):
            # Similar start but different content
            additions.append(t)
    
    return additions

def compare_specific_text_segments(texts1, texts2):
    """Compare specific text segments side by side"""
    # Try to align texts by finding common patterns
    comparisons = []
    
    # Look at first 50 text elements
    for i in range(min(50, len(texts1), len(texts2))):
        t1 = texts1[i]
        t2 = texts2[i]
        
        if t1['text'] != t2['text']:
            # Check if they're related (one is subset/superset of other)
            is_related = (t1['text'] in t2['text']) or (t2['text'] in t1['text']) or \
                        (t1['text'][:20] == t2['text'][:20])
            
            if is_related or i < 20:  # Always show first 20
                comparisons.append({
                    'index': i,
                    'original': t1,
                    'extracted': t2,
                    'is_related': is_related
                })
    
    return comparisons

def analyze_proof_error_context(root):
    """Analyze context around proof errors"""
    contexts = []
    
    def get_element_path(elem):
        """Get path to element"""
        path = []
        parent = elem
        while parent is not None:
            tag = parent.tag.split('}')[-1]
            path.insert(0, tag)
            parent = parent.getparent() if hasattr(parent, 'getparent') else None
        return '/'.join(path[-5:])
    
    for elem in root.iter():
        tag = elem.tag.split('}')[-1]
        if tag == 'proofErr':
            # Get parent
            parent = None
            for p in root.iter():
                if elem in p:
                    parent = p
                    break
            
            # Get siblings
            siblings_text = []
            if parent is not None:
                for sibling in parent:
                    sib_tag = sibling.tag.split('}')[-1]
                    if sib_tag == 't' and sibling.text:
                        siblings_text.append(sibling.text[:50])
                    elif sib_tag == 'proofErr' and sibling == elem:
                        pass  # Skip self
                    elif sib_tag == 'r':
                        # Check children of r
                        for child in sibling:
                            if child.tag.split('}')[-1] == 't' and child.text:
                                siblings_text.append(child.text[:50])
            
            contexts.append({
                'parent_tag': parent.tag.split('}')[-1] if parent else None,
                'path': get_element_path(elem),
                'siblings': siblings_text[:3]  # First 3 siblings
            })
    
    return contexts

# Load files
print("Loading XML files...")
with open('.cursor/document.xml', 'r', encoding='utf-8') as f:
    root1 = ET.fromstring(f.read())

with open('.cursor/document_extr.xml', 'r', encoding='utf-8') as f:
    root2 = ET.fromstring(f.read())

print("Extracting text elements...")
texts1 = extract_text_with_context(root1)
texts2 = extract_text_with_context(root2)

print(f"\n=== TEXT ELEMENT COUNT ===")
print(f"Original: {len(texts1)} text elements")
print(f"Extracted: {len(texts2)} text elements")
print(f"Difference: {len(texts2) - len(texts1)} additional text elements")

# Find differences
print("\n=== SPECIFIC TEXT DIFFERENCES ===")
comparisons = compare_specific_text_segments(texts1, texts2)

print(f"\nFound {len(comparisons)} text differences in first 50 elements:\n")

for comp in comparisons[:15]:
    idx = comp['index']
    orig = comp['original']['text']
    extr = comp['extracted']['text']
    
    print(f"Element {idx}:")
    print(f"  Original ({len(orig)} chars): {repr(orig[:80])}")
    print(f"  Extracted ({len(extr)} chars): {repr(extr[:80])}")
    
    # Check if extracted contains more text
    if len(extr) > len(orig) and orig in extr:
        extra = extr[len(orig):]
        print(f"  -> Added: {repr(extra[:50])}")
    elif len(orig) > len(extr) and extr in orig:
        missing = orig[len(extr):]
        print(f"  -> Removed: {repr(missing[:50])}")
    print()

# Analyze proof errors in detail
print("\n=== PROOF ERROR CONTEXT ANALYSIS ===")
proof_contexts = analyze_proof_error_context(root2)

print(f"\nFound {len(proof_contexts)} proof errors")
print("\nSample proof error contexts:")

for i, ctx in enumerate(proof_contexts[:10]):
    print(f"\n{i+1}. Path: {ctx['path']}")
    print(f"   Parent: {ctx['parent_tag']}")
    if ctx['siblings']:
        print(f"   Nearby text: {ctx['siblings']}")

# Check for paragraph style differences
print("\n=== CHECKING PARAGRAPH STYLES IN TABLES ===")
def find_table_paragraph_styles(root):
    """Find paragraph styles within table cells"""
    styles = []
    
    for elem in root.iter():
        tag = elem.tag.split('}')[-1]
        if tag == 'pStyle':
            # Check if we're in a table
            path = []
            parent = elem
            for _ in range(10):  # Go up to 10 levels
                if parent is None:
                    break
                ptag = parent.tag.split('}')[-1]
                path.insert(0, ptag)
                if ptag == 'tbl':
                    # We're in a table
                    val = elem.get('w:val') or elem.get('val')
                    styles.append({
                        'style': val,
                        'path': '/'.join(path)
                    })
                    break
                parent = parent.getparent() if hasattr(parent, 'getparent') else None
    
    return styles

styles1_table = find_table_paragraph_styles(root1)
styles2_table = find_table_paragraph_styles(root2)

print(f"\nParagraph styles in tables:")
print(f"  Original: {len(styles1_table)}")
print(f"  Extracted: {len(styles2_table)}")

if styles1_table or styles2_table:
    vals1 = {s['style'] for s in styles1_table}
    vals2 = {s['style'] for s in styles2_table}
    print(f"\n  Style values in original: {vals1}")
    print(f"  Style values in extracted: {vals2}")
    
    if vals1 != vals2:
        print(f"  DIFFERENCE: {vals1 ^ vals2}")

# Check for w:rsidRDefault differences more carefully
print("\n=== CHECKING REVISION IDS ===")
def find_rsid_default(root):
    """Find rsidRDefault attributes"""
    rsids = []
    for elem in root.iter():
        rsid = elem.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}rsidRDefault') or \
               elem.get('w:rsidRDefault') or \
               elem.get('rsidRDefault')
        if rsid:
            tag = elem.tag.split('}')[-1]
            rsids.append({
                'tag': tag,
                'rsid': rsid,
                'full_tag': elem.tag
            })
    return rsids

rsids1 = find_rsid_default(root1)
rsids2 = find_rsid_default(root2)

print(f"\nElements with rsidRDefault:")
print(f"  Original: {len(rsids1)}")
print(f"  Extracted: {len(rsids2)}")

if rsids1 or rsids2:
    # Sample some rsids
    print(f"\n  Sample from original: {rsids1[:3] if rsids1 else 'None'}")
    print(f"  Sample from extracted: {rsids2[:3] if rsids2 else 'None'}")

print("\n=== ANALYSIS COMPLETE ===")





