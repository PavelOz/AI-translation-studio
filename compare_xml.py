#!/usr/bin/env python3
"""
Compare two Word XML documents to identify differences
"""
import xml.etree.ElementTree as ET
from collections import defaultdict
import sys

def normalize_xml(xml_string):
    """Normalize XML by removing insignificant whitespace differences"""
    # Remove all namespace prefixes for comparison (they're just for readability)
    root = ET.fromstring(xml_string)
    
    def remove_ns_recursive(el):
        """Recursively remove namespace prefixes from tag names"""
        if el.tag.startswith('{'):
            # Extract local name from {namespace}localname format
            el.tag = el.tag.split('}')[-1]
        for child in el:
            remove_ns_recursive(child)
    
    remove_ns_recursive(root)
    return root

def count_elements(root, counts=None, path=""):
    """Count element types in XML"""
    if counts is None:
        counts = defaultdict(int)
    
    tag = root.tag.split('}')[-1] if '}' in root.tag else root.tag
    full_path = f"{path}/{tag}" if path else tag
    counts[full_path] += 1
    
    for child in root:
        count_elements(child, counts, full_path)
    
    return counts

def get_text_content(root):
    """Extract all text content from XML"""
    texts = []
    
    # Get direct text
    if root.text and root.text.strip():
        texts.append(root.text.strip())
    
    # Get tail text (after element closes)
    if root.tail and root.tail.strip():
        texts.append(root.tail.strip())
    
    # Recursively get text from children
    for child in root:
        texts.extend(get_text_content(child))
    
    return texts

def compare_attributes(elem1, elem2):
    """Compare attributes between two elements"""
    attrs1 = dict(elem1.attrib)
    attrs2 = dict(elem2.attrib)
    
    # Remove namespace declarations (xmlns attributes)
    attrs1 = {k: v for k, v in attrs1.items() if not k.startswith('{') and not k.startswith('xmlns')}
    attrs2 = {k: v for k, v in attrs2.items() if not k.startswith('{') and not k.startswith('xmlns')}
    
    common = set(attrs1.keys()) & set(attrs2.keys())
    only1 = set(attrs1.keys()) - set(attrs2.keys())
    only2 = set(attrs2.keys()) - set(attrs1.keys())
    different = {k for k in common if attrs1[k] != attrs2[k]}
    
    return {
        'common': common,
        'only1': only1,
        'only2': only2,
        'different': different,
        'values': {k: (attrs1.get(k), attrs2.get(k)) for k in different}
    }

def find_differences(root1, root2, path="", depth=0, max_depth=100):
    """Recursively find differences between two XML trees"""
    differences = []
    
    if depth > max_depth:
        return differences
    
    tag1 = root1.tag.split('}')[-1] if '}' in root1.tag else root1.tag
    tag2 = root2.tag.split('}')[-1] if '}' in root2.tag else root2.tag
    
    current_path = f"{path}/{tag1}" if path else tag1
    
    # Compare tags
    if tag1 != tag2:
        differences.append({
            'path': current_path,
            'type': 'tag_mismatch',
            'value1': tag1,
            'value2': tag2
        })
        return differences
    
    # Compare attributes
    attr_diff = compare_attributes(root1, root2)
    if attr_diff['only1'] or attr_diff['only2'] or attr_diff['different']:
        differences.append({
            'path': current_path,
            'type': 'attribute_difference',
            'details': attr_diff
        })
    
    # Compare text content
    text1 = (root1.text or "").strip()
    text2 = (root2.text or "").strip()
    if text1 != text2 and (text1 or text2):
        differences.append({
            'path': current_path,
            'type': 'text_difference',
            'value1': text1[:100] if len(text1) > 100 else text1,
            'value2': text2[:100] if len(text2) > 100 else text2
        })
    
    # Compare children
    children1 = list(root1)
    children2 = list(root2)
    
    if len(children1) != len(children2):
        differences.append({
            'path': current_path,
            'type': 'child_count_difference',
            'count1': len(children1),
            'count2': len(children2)
        })
    
    # Compare child elements (up to min length)
    min_len = min(len(children1), len(children2))
    for i in range(min_len):
        child_diff = find_differences(children1[i], children2[i], current_path, depth + 1, max_depth)
        differences.extend(child_diff)
    
    return differences

# Load and parse XML files
print("Loading XML files...")
with open('.cursor/document.xml', 'r', encoding='utf-8') as f:
    xml1 = f.read()

with open('.cursor/document_extr.xml', 'r', encoding='utf-8') as f:
    xml2 = f.read()

print("Parsing XML...")
root1 = ET.fromstring(xml1)
root2 = ET.fromstring(xml2)

print("\n=== ELEMENT COUNTS ===")
counts1 = count_elements(root1)
counts2 = count_elements(root2)

all_tags = set(counts1.keys()) | set(counts2.keys())
print(f"\nTotal unique element paths: {len(all_tags)}")

# Show differences in counts
diff_counts = []
for tag in sorted(all_tags):
    count1 = counts1.get(tag, 0)
    count2 = counts2.get(tag, 0)
    if count1 != count2:
        diff_counts.append((tag, count1, count2))

if diff_counts:
    print(f"\nElement paths with different counts ({len(diff_counts)} differences):")
    for tag, c1, c2 in diff_counts[:20]:  # Show first 20
        print(f"  {tag}: {c1} -> {c2}")
    if len(diff_counts) > 20:
        print(f"  ... and {len(diff_counts) - 20} more")

# Find structural differences (limited depth to avoid too much output)
print("\n=== STRUCTURAL DIFFERENCES (first 100) ===")
differences = find_differences(root1, root2, max_depth=15)

# Categorize differences
attr_diffs = [d for d in differences if d['type'] == 'attribute_difference']
text_diffs = [d for d in differences if d['type'] == 'text_difference']
tag_diffs = [d for d in differences if d['type'] == 'tag_mismatch']
count_diffs = [d for d in differences if d['type'] == 'child_count_difference']

print(f"\nAttribute differences: {len(attr_diffs)}")
print(f"Text differences: {len(text_diffs)}")
print(f"Tag mismatches: {len(tag_diffs)}")
print(f"Child count differences: {len(count_diffs)}")

# Show some examples
if attr_diffs:
    print("\n--- Sample Attribute Differences ---")
    for diff in attr_diffs[:5]:
        print(f"\nPath: {diff['path']}")
        details = diff['details']
        if details['only1']:
            print(f"  Only in original: {details['only1']}")
        if details['only2']:
            print(f"  Only in extracted: {details['only2']}")
        if details['different']:
            print(f"  Different values: {details['different']}")
            for attr, (v1, v2) in list(details['values'].items())[:3]:
                print(f"    {attr}: '{v1}' -> '{v2}'")

if text_diffs:
    print("\n--- Sample Text Differences ---")
    for diff in text_diffs[:5]:
        print(f"\nPath: {diff['path']}")
        if diff['value1']:
            print(f"  Original: {diff['value1']}")
        if diff['value2']:
            print(f"  Extracted: {diff['value2']}")

# Look for specific patterns - paragraph styles
print("\n=== PARAGRAPH STYLE DIFFERENCES ===")
def find_p_style_diffs(root1, root2):
    """Find differences in paragraph styles (w:pStyle)"""
    styles1 = set()
    styles2 = set()
    
    def extract_styles(root, styles_set):
        for elem in root.iter():
            tag = elem.tag.split('}')[-1]
            if tag == 'pStyle':
                val = elem.get('w:val') or elem.get('val')
                if val:
                    styles_set.add(val)
    
    extract_styles(root1, styles1)
    extract_styles(root2, styles2)
    
    return styles1, styles2

styles1, styles2 = find_p_style_diffs(root1, root2)
print(f"\nUnique paragraph styles in original: {len(styles1)}")
print(f"Unique paragraph styles in extracted: {len(styles2)}")
if styles1 != styles2:
    only1 = styles1 - styles2
    only2 = styles2 - styles1
    if only1:
        print(f"  Only in original: {only1}")
    if only2:
        print(f"  Only in extracted: {only2}")

# Check for proof errors (w:proofErr elements)
print("\n=== PROOF ERROR ELEMENTS ===")
proof_errs1 = [e for e in root1.iter() if e.tag.split('}')[-1] == 'proofErr']
proof_errs2 = [e for e in root2.iter() if e.tag.split('}')[-1] == 'proofErr']
print(f"Proof errors in original: {len(proof_errs1)}")
print(f"Proof errors in extracted: {len(proof_errs2)}")

print("\n=== COMPARISON COMPLETE ===")







