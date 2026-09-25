# convertPdf

Convert PDFs into EPUB e-books. It works on normal PDFs and on scanned books, with or without a text layer: pages that are only pictures of text are read with OCR. The converter:

- rebuilds real paragraphs and joins sentences that break across pages
- removes running headers, footers and page numbers
- splits the book into its real chapters, with section headings in the table of contents
- keeps the pictures (photos, charts, diagrams) where they appear in the text, and uses a picture-only first page as the cover
- embeds a font of your choice, or leaves the font to the e-reader
- reads scanned pages with built-in OCR (English and Indonesian), with nothing extra to install

It runs entirely on your computer. Your files are never uploaded anywhere.

## Download (Windows, no install)

**[Download ConvertPdf.zip](https://github.com/achmadm23/convertPdf/releases/download/v1.0.0/ConvertPdf.zip)** (60 MB)

Unzip it and double-click `ConvertPdf.exe`. You don't need Node.js. See [Share it as one file](#share-it-as-one-file-convertpdfexe) for what happens when it runs.

To convert on macOS or Linux, or to change the code, install it from source as described below.

## Requirements

- [Node.js](https://nodejs.org/) 22.13 or newer (required by pdf.js)
- Windows, macOS or Linux (x64 or arm64). Page rendering uses `@napi-rs/canvas`, which ships prebuilt binaries for these systems.

## Install

```
git clone https://github.com/achmadm23/convertPdf.git
cd convertPdf
npm install
```

## Update

To get the latest version:

```
cd convertPdf
git pull origin main
npm install
```

`npm install` fetches any packages that new versions need (OCR, for example, added `tesseract.js`). If the web app is running, stop it (Ctrl+C) and run `npm start` again so it uses the new code.

If you use `ConvertPdf.exe`, [download the zip](https://github.com/achmadm23/convertPdf/releases/download/v1.0.0/ConvertPdf.zip) again instead.

## Web app (upload, preview, download)

```
npm start
```

Then open **http://localhost:3000** and:

1. **Choose a PDF**, or drag it onto the page.
2. Optionally type a **title** and **author**. If you leave them blank, they're taken from the PDF.
3. Pick a **font**.
4. Click **Convert**. The progress bar shows what's happening, for example "Reading scanned pages: 57 of 244" or "Finding pictures: page 57 of 121", and about how long is left.
5. **Preview** the book on the right. Turn pages with **‹ Prev / Next ›** or the arrow keys, and jump to a chapter from the contents list.
6. Change the font as often as you like. The preview updates in about a second, without converting again.
7. Click **Download**. The button stays disabled until the conversion has finished.

For scanned books, a **Scanned pages** tab shows each page as OCR reads it: the scan, the text read from it, and how confidently it was read. Pages read at 75% or lower are marked (tick **Only pages at 75% or lower** to see just those). Once the conversion has finished, they have two buttons:

- **Retry** reads the page again with other settings (higher resolution, black and white, the page as one block of text) and keeps the best reading if it's better than the first.
- **Edit text** lets you correct the text or type it yourself, looking at the scan next to it. Leave an empty line between paragraphs. Your text is used instead of what OCR read, and the page stays editable.

Then click **Update the book** to use the improved pages. This takes under a minute, because the other pages aren't read again. Pages read below 30% are mostly pictures (a cover, for example) and have neither button.

The server keeps the last 5 converted books in memory so you can change fonts quickly. Restarting the server clears them.

To use a different port:

```
PORT=8080 npm start          # macOS / Linux
$env:PORT=8080; npm start    # Windows PowerShell
```

## Share it as one file (ConvertPdf.exe)

You can build a single `ConvertPdf.exe` for people who don't have Node.js:

```
npm run build:exe
```

This creates `dist/ConvertPdf.exe` (about 120 MB, or about 60 MB zipped). Send it to anyone with Windows. They double-click it and:

- the converter starts and their browser opens it at `http://localhost:3000`
- a console window stays open. **Closing it stops the converter.**
- converting happens on their own computer, so nothing is uploaded anywhere

Details:

- **First run:** the exe unpacks its files (about 64 MB) into `%LOCALAPPDATA%\ConvertPdf`, which takes about 2 seconds. Later starts take under a second. A newer exe replaces the old unpacked files automatically.
- **Double-clicking again** while it's running just opens the browser again.
- **Busy port:** if port 3000 is used by another program, it uses the next free one (3001, 3002, …).
- **Windows warning:** the exe isn't code-signed, so Windows SmartScreen may say "Windows protected your PC" the first time. Click **More info → Run anyway**. Some antivirus programs are also cautious about unsigned exes.
- **Platform:** the exe only works on the system it was built on, here Windows x64. To make a Mac or Linux version, run `npm run build:exe` on that system.

## Command line

```
node index.js input.pdf [output.epub] [--title "Title"] [--author "Author"] [--font id] [--ocr-lang code]
```

If you leave out `output.epub`, the EPUB is saved next to the PDF with the same name.

`--ocr-lang` sets the language of scanned pages: `eng` (English) or `ind` (Indonesian). Without it, the converter tries both on a few pages and uses the one it reads best.

```
node index.js "Homo Deus.pdf"
node index.js book.pdf book.epub --title "My Book" --author "Jane Doe" --font literata
```

## Fonts

| `--font` id | Font | Style |
|---|---|---|
| `default` | The e-reader's own font | Not embedded |
| `literata` | Literata | Serif, designed for e-books |
| `merriweather` | Merriweather | Serif |
| `lora` | Lora | Serif |
| `open-sans` | Open Sans | Sans-serif |
| `atkinson-hyperlegible` | Atkinson Hyperlegible | Sans-serif, designed for readability |

Embedded fonts add about 100 KB to the book and look the same in every e-reader. All of them are open source under the SIL Open Font License.

## Scanned books (OCR)

Pages that have no text, only a picture of the page, are read with OCR ([Tesseract](https://github.com/naptha/tesseract.js), built in). This happens automatically:

- **Language:** English or Indonesian, detected from a few sample pages.
- **What's kept:** lines the OCR is unsure of are left out, because they're usually ornaments, stains or decorative lettering read as nonsense. Paragraphs it reads much worse than the rest of the book, like a letter in a handwriting font, are left out as a whole. Anything left out usually ends up as a picture instead, so a decorative chapter title or a handwritten letter shows as it looks in the book.
- **Chapters:** if the chapter titles can't be read (decorative lettering, for example), chapters start on the pages where the text begins low under a title, and are named "Chapter 1", "Chapter 2", …
- **Accuracy:** clean printed text comes out very well, with the odd wrong letter. Handwriting fonts and large decorative first letters are often misread.

To add a language, install its data (for example `npm install @tesseract.js-data/fra` for French) and add it to `LANGUAGES` in `ocr.js`.

## How long it takes

- **Normal PDFs:** a few seconds.
- **Scanned books with a text layer** take longer when they have pictures, because pages that might hold a picture have to be rendered. A 540-page scanned book with 56 pictures takes about 2 minutes.
- **Scanned books without a text layer** need OCR, about half a second per page on a 12-thread computer, so a 244-page book takes about 2 minutes. It uses up to 8 CPU cores and about 150 MB of memory per core.

## Limitations

- **OCR languages:** only English and Indonesian are included (see [Scanned books](#scanned-books-ocr) to add more).
- **Chapters are found by heading size**, or on scans by where the text starts. A PDF with neither falls back to chapters of 10 pages.
- **Text quality depends on the PDF.** In scanned books, recognition errors (for example a "1" read as "i") come through as they are.
- **Layout:** multi-column layouts and tables come out as plain paragraphs.
- **Pictures:** pages that are mostly pictures, such as ads at the back of a book, are kept as pictures.

## Project layout

| File | What it does |
|---|---|
| `index.js` | Reads the PDF, builds paragraphs and chapters, writes the EPUB. Also the command-line tool. |
| `figures.js` | Finds and crops pictures, and renders the cover. |
| `ocr.js` | Reads scanned pages with OCR (Tesseract). |
| `fonts.js` | Font list and embedding. |
| `server.js` | Local web server for the web app. |
| `public/index.html` | The web app page (upload, progress, preview, font choice). |
| `build/build-exe.js` | Builds `ConvertPdf.exe` (`npm run build:exe`). |
| `build/launcher.js` | Start-up code inside the exe: unpacks the app and starts the server. |
