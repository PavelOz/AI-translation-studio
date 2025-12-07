# AI Translation Studio V2 - Application Documentation

**Version:** 2.3  
**Last Updated:** January 2025  
**Target Audience:** Non-Technical Users, Project Managers, Translators, New Team Members

---

## Table of Contents

1. [What is AI Translation Studio?](#1-what-is-ai-translation-studio)
2. [What Can You Do With It?](#2-what-can-you-do-with-it)
3. [How to Get Started](#3-how-to-get-started)
4. [Main Features Explained](#4-main-features-explained)
5. [Step-by-Step Guides](#5-step-by-step-guides)
6. [Understanding Key Concepts](#6-understanding-key-concepts)
7. [Tips and Best Practices](#7-tips-and-best-practices)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. What is AI Translation Studio?

**AI Translation Studio** is a web-based application that helps you translate documents professionally using artificial intelligence, while maintaining consistency and quality. Think of it as a smart assistant that:

- **Remembers** your past translations so you don't have to translate the same thing twice
- **Suggests** translations based on what you've done before
- **Checks** your work for errors and inconsistencies
- **Organizes** everything by projects and clients
- **Learns** your preferred terminology and style

### Who Is It For?

- **Translators**: Professional linguists who translate documents
- **Project Managers**: People who coordinate translation projects
- **Quality Assurance Specialists**: People who review translations for accuracy
- **Organizations**: Companies that need to translate documents regularly

### What Makes It Special?

Unlike simple translation tools, AI Translation Studio:
- **Stores your translation history** - Every translation you make is saved and can be reused
- **Uses multiple AI providers** - Works with OpenAI, Google Gemini, and Yandex GPT
- **Enforces terminology** - Makes sure you use the correct terms consistently
- **Checks quality automatically** - Finds errors before you finish
- **Organizes by projects** - Keeps everything related to a client or project together

---

## 2. What Can You Do With It?

### Core Capabilities

1. **Upload Documents**
   - Upload Word documents (.docx), Excel files (.xlsx), or XLIFF files (.xliff or .xlf)
   - The system automatically breaks them into translatable segments
   - DOCX files preserve the exact order of paragraphs and tables as they appear in the original document

2. **Translate with AI**
   - Get instant AI-powered translation suggestions
   - Choose from multiple AI providers (OpenAI, Google Gemini, Yandex)
   - Translations respect your terminology and style preferences

3. **Use Translation Memory**
   - Automatically find similar translations you've done before
   - Reuse past translations with one click
   - Build a database of your translations over time

4. **Manage Terminology**
   - Create a glossary of preferred terms
   - Ensure consistent terminology across all translations
   - Import glossaries from Excel files

5. **Quality Assurance**
   - Automatic checks for terminology errors
   - Verification of numbers, dates, and formatting
   - AI-powered quality checking for deeper analysis

6. **Organize Projects**
   - Group documents by client or project
   - Track progress and completion
   - Generate reports on productivity

7. **Export Translated Documents**
   - Download completed translations in the same format as the original
   - Original formatting and structure are preserved
   - Paragraph and table order maintained in DOCX files
   - Ready to deliver to clients

---

## 3. How to Get Started

### First Time Setup

1. **Log In**
   - Open the application in your web browser
   - Enter your email and password
   - If you don't have an account, contact your administrator

2. **Navigate the Interface**
   - **Dashboard**: Overview of all your projects and activity
   - **Projects**: Create and manage translation projects
   - **Translation Memory**: View and manage your translation database
   - **Glossary**: Manage your terminology dictionary
   - **Reports**: View productivity and quality statistics

3. **Create Your First Project**
   - Click "New Project" on the Projects page
   - Enter project name, client name, and languages
   - Save the project

4. **Upload a Document**
   - Open your project
   - Click "Upload Document"
   - Select your file (Word, Excel, or XLIFF)
   - Wait for the system to process it

5. **Start Translating**
   - Click on the document to open the editor
   - The system will show you translation suggestions
   - Choose a suggestion or translate manually
   - Confirm each segment as you complete it

---

## 4. Main Features Explained

### 4.1 Translation Editor

The translation editor is where you do your work. It's divided into several areas:

**Left Side - Segment List**
- Shows all the text segments in your document
- Segments appear in the same order as in the original document
- Each segment shows its type (paragraph, table-cell, cell, etc.)
- Color-coded by status:
  - White = Not started
  - Light Blue = Machine translated (AI suggestion)
  - Light Yellow = Edited
  - Light Green = Confirmed (final)

**Center - Main Editor**
- Shows the source text (what you're translating from)
- Displays segment type (paragraph, table cell, etc.)
- Text box for your translation
- Buttons to confirm, edit, or get AI suggestions

**Right Side - Helpful Panels**
- **AI Translation**: Get AI-powered translation suggestions
- **Translation Memory**: See similar translations from your database
- **Glossary**: View relevant terminology for this segment
- **Guidelines**: See project-specific translation rules
- **Quality Checks**: View any errors or warnings

**Keyboard Shortcuts**
- `Ctrl + ↑/↓`: Navigate between segments
- `Ctrl + Enter`: Confirm current segment

### 4.2 Translation Memory

**What It Is:**
Translation Memory (TM) is a database of all your past translations. Every time you confirm a translation, it's saved to the TM.

**How It Helps:**
- When you translate something similar, the system finds it automatically
- You can reuse exact or similar translations
- Maintains consistency across all your work

**Two Types:**
- **Project TM**: Translations specific to one project
- **Global TM**: Translations shared across all projects

**Search Methods:**
- **Fuzzy Search**: Finds text that's similar (like "house" and "houses")
- **Vector Search**: Finds text with similar meaning (like "house" and "home")
- **Hybrid Search**: Combines both methods for best results

**Search Profiles:**
- **Legal Profile**: High precision, strict matching (for legal documents)
- **Technical Profile**: Balanced approach (for technical documentation) - Default
- **Explore Profile**: Maximum recall (shows all possible matches)

**Managing Translation Memory:**
- Go to "Translation Memory" in the main menu
- View all your translations with pagination
- Filter by project (All Projects, General/Global, or specific project)
- Search for specific translations
- Edit or delete entries
- Use "Find & Replace" to update multiple entries at once
- Import TMX files from other translation systems

### 4.3 Glossary Management

**What It Is:**
A glossary is a list of preferred terms and their translations. For example, "реконструкция" must always be translated as "rehabilitation" (not "reconstruction").

**Features:**
- **Add Terms**: Create new glossary entries
- **Edit Terms**: Update existing entries
- **Delete Terms**: Remove outdated entries
- **Import from CSV**: Bulk import terms from Excel files
- **Filter**: Find terms by project or language
- **Search**: Quickly find specific terms
- **Context Rules**: Specify where terms should or should not be used

**Enforcement Modes:**
- **Off**: Glossary is ignored (not recommended)
- **Strict (Source Only)**: Enforced when term appears in source text (recommended)
- **Strict (Semantic)**: Enforced based on meaning (experimental)

**Visual Indicators:**
- Red badge: Forbidden term (must use exactly, no alternatives)
- Yellow badge: Deprecated term (should not be used)
- Green badge: Preferred term (should be used)

**Context Rules:**
You can specify when a glossary term should or should not be used:
- **Use Only In**: Only use this term in specific contexts/domains (e.g., "legal", "medical")
- **Exclude From**: Never use this term in these contexts (e.g., "marketing", "casual")
- **Document Types**: Only use in specific document types (e.g., "contract", "report")
- **Requires**: Only use when certain conditions are met (e.g., "formal_tone", "technical")

**Example:**
- Term: "rehabilitation" 
- Use Only In: "medical, healthcare"
- Exclude From: "legal, contracts"
- This means: Use "rehabilitation" only in medical/healthcare contexts, never in legal documents

**Glossary Page:**
- Accessible from main navigation menu
- View all glossary entries in one place
- Full management capabilities (add, edit, delete, import)
- Filter by project, source locale, and target locale
- Search across terms, descriptions, and notes

### 4.4 AI Translation

**Supported Providers:**
- **OpenAI**: GPT-4o-mini, GPT-4, and other models
- **Google Gemini**: Gemini Pro and other models
- **Yandex GPT**: Yandex's AI models

**How It Works:**
1. You select a segment to translate
2. Click "Translate" in the AI Translation panel
3. The AI considers:
   - Your translation memory examples
   - Your glossary terms
   - Project guidelines
   - Context from surrounding segments
4. Returns a translation suggestion
5. You can apply it, edit it, or request a new one

**Glossary Enforcement:**
- The AI respects your glossary settings
- If a glossary term appears, the AI must use it
- If it can't use the glossary term, it reports an error

**Setting Up AI:**
- Go to your project settings
- Click "AI Settings"
- Select AI provider
- Enter API key (if required)
- Test credentials
- Save settings

### 4.5 Quality Assurance

**Automatic Checks:**
- **Terminology**: Verifies glossary terms are used correctly
- **Numbers/Units**: Checks that numbers match the source
- **Formatting**: Verifies tags and formatting are preserved
- **Consistency**: Checks for inconsistent translations

**Post-Edit QA (AI-Powered):**
- Advanced quality checking using AI
- Detects meaning errors, omissions, and style issues
- Provides detailed reports with suggestions
- Categorizes issues as errors (critical) or warnings (non-critical)

**Quality Metrics:**
- Term errors count
- Format errors count
- Consistency errors count
- Edit distance (how much you changed from AI suggestion)

**Understanding QA Results:**
- **Red (Error)**: Critical issues that must be fixed
  - Glossary violations
  - Wrong numbers
  - Missing formatting tags
- **Yellow (Warning)**: Non-critical issues
  - Inconsistent terminology
  - Style problems
- **Blue (Info)**: Informational messages

### 4.6 Project Management

**Creating Projects:**
- Name your project
- Add client name (optional)
- Specify source and target languages
- Set due date (optional)
- Add domain/industry (optional)

**Project Features:**
- Organize documents by project
- Track progress and completion
- Set project-specific AI settings
- Create project-specific guidelines
- Manage project members

**Project Status:**
- **Planning**: Project is being set up
- **In Progress**: Active translation work
- **On Hold**: Temporarily paused
- **Completed**: All work finished

### 4.7 Reports

**Project Reports:**
- Total segments in project
- Translated segments count
- Completion percentage
- Quality metrics
- Time spent
- Word count

**User Reports:**
- Segments translated by user
- Quality scores
- Productivity metrics
- Time tracking

### 4.8 Database Status Indicator

**What It Is:**
A visual indicator in the top navigation bar that shows whether the database is connected.

**Status Indicators:**
- 🟢 **Green dot**: Database is connected and working
- 🔴 **Red dot**: Database is disconnected (contact administrator)
- 🟡 **Yellow dot**: Checking connection status

**Why It Matters:**
- If database is disconnected, you may not be able to save your work
- The indicator automatically checks every 30 seconds
- Shows last check time when you hover over it

---

## 5. Step-by-Step Guides

### 5.1 Translating a Document

1. **Open Your Project**
   - Go to Projects page
   - Click on your project

2. **Upload Document**
   - Click "Upload Document"
   - Select your file (Word, Excel, or XLIFF)
   - Wait for processing

3. **Open Editor**
   - Click on the document name
   - Click "Open Editor" or "Edit"

4. **Translate Segments**
   - Click on the first segment in the list
   - Review the source text
   - Check Translation Memory suggestions (right panel)
   - Either:
     - Click "Apply" on a TM suggestion, OR
     - Click "Translate" in AI panel for AI suggestion, OR
     - Type your translation manually
   - Edit the translation if needed
   - Click "Confirm" when satisfied
   - Use arrow keys or click to move to next segment

5. **Use Keyboard Shortcuts**
   - `Ctrl + ↓`: Next segment
   - `Ctrl + ↑`: Previous segment
   - `Ctrl + Enter`: Confirm current segment

6. **Export When Done**
   - Click "Download" button
   - Save the translated file

### 5.2 Using Translation Memory

**In the Editor:**
1. Select a segment
2. Check the "TM Suggestions" panel (right side)
3. Review the matches (sorted by similarity)
4. Each match shows:
   - Match percentage (how similar it is)
   - Source and target text
   - Whether it's from project TM or global TM
   - Which TMX file it came from (if imported)
5. Click "Apply" on the best match
6. Edit if needed, then confirm

**Managing Translation Memory:**
1. Go to "Translation Memory" in main menu
2. View all your translations with pagination
3. Filter by project:
   - "All Projects" - Shows both project and global entries
   - "General" - Shows only global entries
   - Specific project name - Shows only that project's entries
4. Search for specific translations
5. Edit entries: Click "Edit" to modify source/target text or match rate
6. Delete entries: Click "Delete" to remove unwanted entries
7. Use "Find & Replace" for bulk updates
8. Import TMX files from other systems

**Adding to Translation Memory:**
- **Automatically**: When you confirm a segment, it's added to TM
- **Manually**: Go to TM page, click "Add Entry"

**TM Search Profiles:**
1. In Editor sidebar, find "TM Suggestions" panel
2. Click profile button:
   - **Legal**: High precision (70% min, strict) - for legal documents
   - **Technical**: Balanced (50% min, strict) - Default, for technical docs
   - **Explore**: Maximum recall (40% min, extended) - shows all matches
3. Profile applies immediately
4. You can customize settings manually (switches to "Custom" profile)

### 5.3 Managing Glossary

**Adding Glossary Terms:**
1. Go to "Glossary" in main menu
2. Click "Add Entry"
3. Enter source term (e.g., "реконструкция")
4. Enter target term (e.g., "rehabilitation")
5. Select source and target languages
6. Choose project (or leave as "Global")
7. Add description or notes (optional)
8. Set status: Preferred or Deprecated
9. Mark as "Forbidden" if term must be used exactly
10. (Optional) Click "Show Context Rules" to specify when/where to use this term:
    - **Use Only In**: Enter contexts where term should be used (comma-separated)
    - **Exclude From**: Enter contexts where term should NOT be used (comma-separated)
    - **Document Types**: Enter document types where term should be used
    - **Requires**: Enter conditions that must be met
11. Click "Create"

**Importing Glossary:**
1. Go to Glossary page
2. Click "Import CSV"
3. Select your CSV file
4. Specify source and target languages
5. Choose project (optional, leave empty for global)
6. Click "Import"

**Editing Glossary:**
1. Go to Glossary page
2. Find the entry you want to edit
3. Click "Edit" button
4. Modify any field (terms, locales, description, notes, status, forbidden flag, context rules)
5. Click "Show Context Rules" to edit context-specific usage rules if needed
6. Click "Update" to save changes

**Using Glossary in Translation:**
1. Set glossary mode in Editor sidebar:
   - "Off" - Glossary ignored
   - "Strict (source only)" - Recommended, enforced when term appears literally
   - "Strict (semantic)" - Experimental, semantic matching
2. When translating, glossary terms are automatically enforced
3. AI translations will use glossary terms
4. QA checks will flag glossary violations

**Filtering Glossary:**
   - Use project dropdown to filter by project
   - Use source/target locale dropdowns to filter by language
   - Use search box to find specific terms
   - Search works across source terms, target terms, descriptions, and notes

### 5.4 Using AI Translation

**Setting Up AI:**
1. Go to your project
2. Click "AI Settings"
3. Select AI provider (OpenAI, Gemini, or Yandex)
4. Enter API key (if required)
5. Test credentials
6. Save settings

**Translating with AI:**
1. Open document in editor
2. Select a segment
3. Open "AI Translation" panel (right side)
4. Select provider (if multiple configured)
5. Make sure glossary mode is set (if you want glossary enforced)
6. Click "Translate"
7. Wait for result
8. Review the translation
9. Click "Apply" to use it, or edit first

**Batch Translation:**
1. In editor, click "Pretranslate" or "Batch Translate"
2. Choose options:
   - Apply 100% TM matches automatically
   - Translate empty segments with AI
   - Translate segments with low TM matches
3. Select glossary mode (if needed)
4. Click "Start"
5. Monitor progress
6. Review and edit results

### 5.5 Quality Assurance

**Running QA Checks:**
1. In editor, select a segment
2. QA panel shows issues automatically
3. Review errors and warnings
4. Fix issues in translation
5. QA updates automatically

**Understanding QA Results:**
- **Red (Error)**: Critical issues that must be fixed
  - Glossary violations
  - Wrong numbers
  - Missing formatting tags
- **Yellow (Warning)**: Non-critical issues
  - Inconsistent terminology
  - Style problems
- **Blue (Info)**: Informational messages

**Post-Edit QA:**
- Advanced AI-powered quality checking
- Available via API (for advanced users)
- Provides detailed analysis
- Shows specific issues with suggestions
- Categorizes by severity (error/warning)

### 5.6 Managing Projects

**Creating a Project:**
1. Go to Projects page
2. Click "New Project"
3. Fill in:
   - Project name (required)
   - Description (optional)
   - Client name (optional)
   - Domain/industry (optional)
   - Source language (required)
   - Target language(s) (required)
   - Due date (optional)
4. Click "Create"

**Managing Project Settings:**
1. Open your project
2. Click "AI Settings" to configure AI provider
3. Click "Guidelines" to add translation rules
4. Add project members if needed

**Viewing Project Progress:**
1. Open your project
2. See document list with status indicators
3. Check completion percentages
4. View project reports for detailed statistics

---

## 6. Understanding Key Concepts

### 6.1 Segments

A **segment** is a single unit of text to translate. It could be:
- A paragraph (most common in Word documents)
- A cell in a table (within Word documents)
- A cell in a spreadsheet (Excel files)
- A translation unit in an XLIFF file

Each segment has:
- **Source text**: The original text
- **Target text**: Your translation
- **Status**: NEW, MT (machine translated), EDITED, or CONFIRMED
- **Segment Type**: Identifies the content type (paragraph, table-cell, cell, unit, etc.)
- **Segment Index**: Position in the document (preserves order)

**Order Preservation:**
- Segments are extracted and displayed in the exact order they appear in the source document
- For DOCX files, paragraphs and tables maintain their original sequence
- This ensures the translated document structure matches the original

### 6.2 Translation Memory (TM)

**Translation Memory** is like a database of your past work. Every confirmed translation is saved.

**Benefits:**
- Consistency: Same text always translated the same way
- Speed: Reuse past translations
- Quality: Use proven translations

**Match Types:**
- **100% Match**: Exact same text
- **Fuzzy Match**: Similar text (e.g., 85% similar)
- **Vector Match**: Similar meaning (semantic similarity)
- **Hybrid Match**: Found by both fuzzy and vector search

**Project vs Global TM:**
- **Project TM**: Translations specific to one project, prioritized in search results
- **Global TM**: Translations shared across all projects, available everywhere
- When searching, both are searched simultaneously and results are merged

### 6.3 Glossary

A **glossary** is your terminology dictionary. It tells the system:
- "This term MUST be translated this way"
- "Never use this term"
- "Prefer this term over others"

**Types of Entries:**
- **Preferred**: Should be used when possible
- **Forbidden**: Must be used exactly, no alternatives
- **Deprecated**: Should not be used anymore

**Project vs Global Glossary:**
- **Project Glossary**: Terms specific to one project
- **Global Glossary**: Terms shared across all projects
- Both are used when translating in a project

**Context-Aware Filtering:**
- Glossary entries can have context rules that specify when they should be used
- Terms are automatically filtered based on:
  - Project domain (from project settings)
  - Project client (from project settings)
  - Document name and type
- Terms are only applied when their context rules match the current document/project context
- This ensures terms are used appropriately for different document types and contexts
- Example: A term with "Use Only In: medical" will only be used in medical projects
- Example: A term with "Exclude From: legal" will never be used in legal documents

### 6.4 Projects

A **project** groups related work together:
- All documents for one client
- All translations for one website
- All work in one language pair

**Benefits:**
- Organization: Everything in one place
- Project-specific TM: Build specialized translation memory
- Project-specific glossary: Use client-specific terminology
- Tracking: Monitor progress and completion

### 6.5 AI Providers

**AI Providers** are the services that power AI translation:
- **OpenAI**: Creator of GPT models
- **Google Gemini**: Google's AI models
- **Yandex GPT**: Yandex's AI models

Each has different:
- Strengths and weaknesses
- Pricing
- Language support
- Quality levels

### 6.6 RAG (Retrieval-Augmented Generation)

**RAG** means the AI looks at your past translations before generating new ones. It's like showing the AI examples of your work so it can match your style.

**How It Works:**
1. You request a translation
2. System searches your Translation Memory
3. Finds top 5 similar translations
4. Shows them to the AI as examples
5. AI generates translation matching your style

### 6.7 Vector Embeddings

**Vector Embeddings** are a way to find text with similar meaning, not just similar words. For example:
- "house" and "home" have similar meaning
- "car" and "automobile" have similar meaning
- Traditional search might not find these, but vector search will

**How It's Used:**
- When you search Translation Memory, vector search finds semantically similar translations
- Helps find translations even when wording is different
- Makes the system smarter about finding relevant matches

---

## 7. Tips and Best Practices

### For Translators

1. **Build Your Translation Memory**
   - Confirm segments to add them to TM
   - The more you use the system, the better it gets
   - Review and clean up TM entries periodically

2. **Use Glossary Consistently**
   - Add terms as you encounter them
   - Mark important terms as "Forbidden"
   - Review glossary regularly
   - Import client glossaries early in the project

3. **Check TM Suggestions First**
   - Always review TM matches before using AI
   - TM matches are usually more accurate than AI
   - Project TM entries are prioritized, so they appear first

4. **Use Appropriate Search Profiles**
   - Legal documents: Use "Legal" profile (high precision)
   - Technical docs: Use "Technical" profile (default, balanced)
   - Creative content: Use "Explore" profile (maximum recall)

5. **Review QA Warnings**
   - Fix errors immediately
   - Consider warnings carefully
   - Maintain quality standards

6. **Use Keyboard Shortcuts**
   - `Ctrl + ↓` to move to next segment
   - `Ctrl + ↑` to move to previous segment
   - `Ctrl + Enter` to confirm segment
   - Saves time when translating many segments

### For Project Managers

1. **Set Up Projects Properly**
   - Use clear project names
   - Add client information
   - Set appropriate due dates
   - Add domain/industry for better organization

2. **Create Project Glossaries**
   - Import client glossaries early
   - Review and update regularly
   - Communicate glossary changes to team
   - Mark critical terms as "Forbidden"

3. **Monitor Progress**
   - Check project reports regularly
   - Review completion percentages
   - Address quality issues promptly
   - Track time spent on projects

4. **Organize by Client**
   - Create separate projects for each client
   - Use consistent naming conventions
   - Archive completed projects
   - Keep project-specific TM and glossary separate

5. **Configure AI Settings**
   - Set up AI provider for each project
   - Test credentials before starting work
   - Choose appropriate AI model for project type

### For Quality Assurance

1. **Use QA Features**
   - Review QA panels in editor
   - Run Post-Edit QA for important documents
   - Document common issues
   - Create guidelines based on QA findings

2. **Maintain Glossary**
   - Keep glossary up to date
   - Remove deprecated terms
   - Add new preferred terms
   - Mark critical terms as "Forbidden"

3. **Review Translation Memory**
   - Check for incorrect entries
   - Update or delete bad translations
   - Use Find & Replace for bulk updates
   - Ensure consistency across entries

4. **Monitor Quality Metrics**
   - Review term error counts
   - Check format error rates
   - Track consistency issues
   - Identify patterns in errors

---

## 8. Troubleshooting

### Common Issues and Solutions

**Problem: Can't log in**
- Check your email and password
- Contact administrator if account doesn't exist
- Clear browser cache and try again
- Check if Caps Lock is on

**Problem: Document won't upload**
- Check file format (must be .docx, .xlsx, .xliff, or .xlf)
- Ensure file isn't too large (check with administrator for size limits)
- Check internet connection
- Try a different browser
- Make sure file isn't corrupted

**Problem: Document segments appear in wrong order**
- DOCX files now preserve paragraph and table order correctly
- If you see order issues, try re-importing the document
- Check that you're using the latest version of the application
- For complex documents with mixed content, the system maintains the original structure

**Problem: AI translation not working**
- Check AI settings in project
- Verify API key is correct
- Try a different AI provider
- Check if you have API credits/quota
- Contact administrator if issue persists

**Problem: Translation Memory not finding matches**
- Try different search profile (Legal/Technical/Explore)
- Lower the minimum match threshold in settings
- Enable vector search for semantic matches
- Check if you're filtering by wrong project
- Make sure TM entries exist for your language pair

**Problem: Glossary terms not being used**
- Check glossary mode is set to "Strict (source only)" or "Strict (semantic)"
- Verify term appears in source text (for source-only mode)
- Check term is in correct project glossary
- Make sure term isn't marked as "Deprecated"
- Verify source and target locales match

**Problem: Can't export document**
- Ensure all segments are confirmed (or at least the ones you want)
- Check file isn't corrupted
- Try downloading again
- Contact administrator if issue persists

**Problem: Database connection error**
- Check database status indicator (top right of screen)
- Green dot = connected, Red dot = disconnected
- Contact administrator if database is down
- Wait a few minutes and try again
- Don't work if database is disconnected (your work may not save)

**Problem: Slow performance**
- Check internet connection
- Close other browser tabs
- Try refreshing the page
- Clear browser cache
- Contact administrator if issue persists

**Problem: Can't see my translations in TM**
- Check project filter (might be filtering to wrong project)
- Try "All Projects" filter
- Check if entries were added to correct project
- Verify you're looking at correct language pair

**Problem: Glossary import failed**
- Check CSV file format (must have correct columns)
- Verify source and target locales are correct
- Check file encoding (should be UTF-8)
- Make sure file isn't too large
- Review error message for specific issue

### Getting Help

- **Check this documentation** first - most issues are covered here
- **Review error messages** - they often explain the issue clearly
- **Contact your administrator** for system issues or account problems
- **Check browser console** for technical errors (press F12, look at Console tab)
- **Take a screenshot** of error messages when asking for help

### When to Contact Administrator

Contact your administrator if you experience:
- Database connection errors that persist
- Account access issues
- System-wide problems affecting all users
- API key or AI provider configuration issues
- File upload problems that affect all file types
- Performance issues that affect everyone

---

## Conclusion

AI Translation Studio is a powerful tool that combines artificial intelligence with your translation expertise. By using Translation Memory, Glossary, and Quality Assurance features, you can:

- **Work faster** by reusing past translations
- **Maintain consistency** across all your work
- **Ensure quality** with automatic checks
- **Organize effectively** with project management

Remember: The system learns from you. The more you use it, the better it becomes at helping you.

---

**Document Version**: 2.3  
**Last Updated**: January 2025  
**For Technical Details**: See technical documentation files in `/docs` folder

---

## File Format Support

**DOCX (Word Documents):**
- Supports paragraphs, tables, headers, and footers
- Preserves formatting and document structure
- Maintains exact order of paragraphs and tables
- Optional LibreOffice integration for enhanced parsing (if configured)

**XLSX (Excel Files):**
- Supports multiple sheets
- Extracts cell content as segments
- Preserves sheet names and cell positions

**XLIFF (Translation Exchange Format):**
- Standard format for translation projects
- Supports both .xliff and .xlf file extensions
- Preserves translation units and tags
- Supports metadata and notes

---

## Quick Reference

### Main Pages
- **Dashboard**: `/` - Overview of projects
- **Projects**: `/projects` - Manage projects
- **Translation Memory**: `/translation-memory` - Manage TM
- **Glossary**: `/glossary` - Manage terminology
- **Reports**: `/reports` - View statistics

### Keyboard Shortcuts
- `Ctrl + ↓`: Next segment
- `Ctrl + ↑`: Previous segment
- `Ctrl + Enter`: Confirm segment

### Status Colors
- White: Not started
- Light Blue: Machine translated
- Light Yellow: Edited
- Light Green: Confirmed

### QA Severity
- Red: Error (must fix)
- Yellow: Warning (should fix)
- Blue: Info (informational)

### Database Status
- 🟢 Green: Connected
- 🔴 Red: Disconnected
- 🟡 Yellow: Checking

### TM Search Profiles
- **Legal**: High precision (70% min, strict)
- **Technical**: Balanced (50% min, strict) - Default
- **Explore**: Maximum recall (40% min, extended)

### Glossary Modes
- **Off**: Glossary ignored
- **Strict (source only)**: Enforced when term appears literally - Recommended
- **Strict (semantic)**: Semantic matching - Experimental
