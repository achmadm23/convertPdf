# convertPdf

Convert PDFs into EPUB e-books. It works on normal PDFs and on scanned books, with or without a text layer: pages that are only pictures of text are read with OCR. The converter:

- rebuilds real paragraphs and joins sentences that break across pages
- removes running headers, footers and page numbers
- splits the book into its real chapters, with section headings in the table of contents
- keeps the pictures (photos, charts, diagrams) where they appear in the text, and uses a picture-only first page as the cover
- lets you use a picture of your own as the cover instead
- shows every picture, the cover and pages kept as a picture on a page of its own that it fills, in the 4 shades of gray of an e-ink screen, sized for your reader: 480 x 800 for the Xteink X4 and X4 Pro, 528 x 792 for the X3
- leaves the font to the e-reader, so the book reads in the font and size you choose there
- reads scanned pages with built-in OCR (English and Indonesian), with nothing extra to install
- can also make an XTC book for Xteink X3, X4 and X4 Pro readers, with every page drawn for the reader's screen (see [Xteink books](#xteink-books-xtc))

It runs entirely on your computer. Your files are never uploaded anywhere.

## Use it online

**[Open convertPdf](https://achmadm23.github.io/convertPdf/)** in your browser: nothing to install, on Windows, macOS, Linux, or a tablet.

The website does everything the app does, and the converting happens inside your browser: your PDF is never uploaded. It's slower than the app on big scanned books, because OCR uses your browser instead of all your computer's cores, and the first scanned book downloads the OCR language data (about 4 MB, kept by the browser afterwards).

The site is published from this repository by GitHub Pages: every push to `main` rebuilds it (`.github/workflows/pages.yml`). To build it yourself, run `npm run build:web` and serve the `site/` folder.

## Download (Windows, no install)

**[Download ConvertPdf.zip](https://github.com/achmadm23/convertPdf/releases/download/v1.2.1/ConvertPdf.zip)** (60 MB)

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

If you use `ConvertPdf.exe`, [download the zip](https://github.com/achmadm23/convertPdf/releases/download/v1.2.1/ConvertPdf.zip) again instead.

## Web app (upload, preview, download)

```
npm start
```

Then open **http://localhost:3000**. The steps are numbered down the left of the page:

1. **PDF:** choose a PDF, or drop it on the page.
2. **Output:** an EPUB e-book for any e-reader, or an XTC book for an Xteink reader ([Xteink books](#xteink-books-xtc)).
3. **Details:** optionally type a title and author. If you leave them blank, they're taken from the PDF.
4. **Cover:** optionally choose a picture (JPEG, PNG or WebP, up to 20 MB), or drop it on the Cover box. It replaces the cover taken from the PDF.
5. **Reader:** your e-reader (Xteink X4 Pro, X4 or X3). An EPUB's pictures and cover are drawn for its screen, and the preview shows the book at its size. **Full-page pictures** chooses how portrait pictures that fill most of their page go in the book: **Whole**, upright, or turned on their side and cut into **2 parts** or **3 parts** that each fill the screen, as in an XTC book. Changing it updates the book at once, without converting again. For an XTC book, also black and white or 4 grays, and whether pages are turned sideways.

Then click **Convert**. The progress bar shows what's happening, for example "Reading scanned pages: 57 of 244", and about how long is left; the panel on the right lists each step.

The book appears on an e-reader in the middle of the page, laid out at your reader's screen size (480 x 800 on an X4 Pro), so lines and picture pages fall roughly as they will on the device; its own font and margins may differ a little. Move through it with the **slider** under the reader, which stops at every picture page too, or the arrow keys, and jump to a chapter from **Contents** on the right. Change the cover as often as you like: the preview updates in about a second, without converting again, and **Remove** goes back to the PDF's own cover. When it looks right, click **Download**. **Convert again** converts the PDF anew, for example with other XTC settings.

The page follows your system's light or dark theme, and works offline: its fonts are served by the converter.

For scanned books, a **Scanned pages** tab shows each page as OCR reads it: the scan, the text read from it, and how confidently it was read. Pages read at 75% or lower are marked. Once the conversion has finished, they have two buttons:

- **Retry** reads the page again with other settings (higher resolution, black and white, the page as one block of text) and keeps the best reading if it's better than the first.
- **Edit text** lets you correct the text or type it yourself, looking at the scan next to it. Leave an empty line between paragraphs. Your text is used instead of what OCR read, and the page stays editable.

Pages read at 90% or lower also have **Keep as picture**, which puts the whole page in the book as a picture instead of its text: for a handwritten letter, a table, or a page OCR garbles. Choose **Whole page** to keep it upright, or **2 parts** or **3 parts** to have it turned on its side and cut into halves, or thirds that overlap a little, as in an XTC book: each part fills the screen, so the text is bigger. Turn your e-reader on its side to read them. **Use text** undoes it. A first page kept whole as a picture becomes the book's cover. Tick **Only pages at 90% or lower** to see just the pages with these buttons.

Then click **Update the book** to use the changed pages. This takes under a minute, because the other pages aren't read again. Pages read below 30% are mostly pictures (a cover, for example) and have neither Retry nor Edit text.

The server keeps the last 5 converted books in memory so you can change their cover quickly. Restarting the server clears them.

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
node index.js input.pdf [output.epub] [--title "Title"] [--author "Author"] [--cover image] [--device x4|x4-pro|x3] [--picture-parts 2|3] [--ocr-lang code]
```

If you leave out `output.epub`, the EPUB is saved next to the PDF with the same name.

`--cover` uses a picture (JPEG, PNG or WebP) as the book's cover instead of the PDF's first page.

`--device` sizes the book's pictures and cover for that e-reader's screen: `x4` and `x4-pro` (480 x 800, the default) or `x3` (528 x 792).

`--picture-parts 2` or `3` turns full-page portrait pictures on their side and cuts them into 2 or 3 parts that each fill the screen.

`--ocr-lang` sets the language of scanned pages: `eng` (English) or `ind` (Indonesian). Without it, the converter tries both on a few pages and uses the one it reads best.

```
node index.js "Homo Deus.pdf"
node index.js book.pdf book.epub --title "My Book" --author "Jane Doe" --cover cover.jpg
```

For an Xteink reader, add `--format xtc` (black and white) or `--format xtch` (4 shades of gray). The book is saved as `input.xtc` or `input.xtch`.

```
node index.js input.pdf [output.xtc] --format xtc|xtch [--device x4|x4-pro|x3] [--orientation landscape|portrait]
  [--split overlap|half|none] [--dither atkinson|floyd|sierra-lite|ordered|none] [--contrast 0-8]
  [--crop percent[,percent]] [--no-cover-page] [--flip] [--title ...] [--author ...] [--cover image]
```

Without options it makes a black and white book for the X4, with pages turned sideways in overlapping parts and Atkinson dithering. `--crop 10,5` trims 10% off the left and right of every page and 5% off the top and bottom. `--no-cover-page` treats the first page like any other, and `--flip` turns sideways pages the other way.

```
node index.js manga.pdf --format xtch --device x3 --orientation portrait
```

## Xteink books (XTC)

For Xteink readers (X3, X4 and X4 Pro), convertPdf can also make an XTC book: every PDF page drawn ready for the reader's screen, the way [XTC.js](https://xtcjs.app/pdf) does. Choose **Output: XTC for Xteink X3, X4 and X4 Pro** in the web app, or use `--format xtc` on the command line. Pages keep their layout exactly as in the PDF, so this suits manga, comics, scans and PDFs with tables, columns or formulas. The text isn't rebuilt or read with OCR.

| Setting | Choices |
|---|---|
| Device | Xteink X4 and X4 Pro (480 x 800), Xteink X3 (528 x 792) |
| Shades | Black and white (`.xtc`, faster page turns) or 4 shades of gray (`.xtch`, better for photos and shading) |
| Pages | **Sideways** (the default): each page is turned on its side so its text is bigger, and cut into 3 or more overlapping parts, 2 halves, or not cut. **Upright**: each page whole. |
| More settings | Dithering (Atkinson, Floyd-Steinberg, Sierra Lite, Ordered or none), contrast, trimming wide margins, whether the first page is the cover (shown whole and upright), and which way sideways pages turn |

The PDF's bookmarks become the book's chapters, and its title and author are kept. A cover picture of your own replaces the first page when that is the cover, or comes before it otherwise. The preview shows each page as the reader will.

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
- **XTC books:** about a fifth of a second per PDF page when pages are cut into sideways parts, less for upright pages, so a 100-page PDF takes about 20 seconds.
- **On the website** everything takes longer than in the app, often 2 to 4 times as long, depending on your computer and browser.

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
| `figures.js` | Finds and crops pictures, and renders the cover (from the PDF or a picture you choose). |
| `eink.js` | Turns pictures into full-screen e-ink pages (480 x 800, 4 shades of gray, dithered). |
| `ocr.js` | Reads scanned pages with OCR (Tesseract). |
| `ocr-platform.js` | Where OCR finds its language data and how many pages it reads at once (the app's settings). |
| `xtc.js` | Draws PDF pages for an Xteink screen (fit or split, contrast, dithering) and makes the XTC book. |
| `xtcfile.js` | The XTC/XTCH file format: page encoding (XTG, XTH) and the book file. |
| `pdf.js` | Opens a PDF with pdf.js. |
| `server.js` | Local web server for the web app. |
| `public/index.html` | The web app page: the numbered steps, progress, the e-reader preview with its slider, and contents. |
| `build/build-exe.js` | Builds `ConvertPdf.exe` (`npm run build:exe`). |
| `build/launcher.js` | Start-up code inside the exe: unpacks the app and starts the server. |
| `web/api.js` | The website's converter: the server's work, done in the browser. |
| `web/build.js` | Builds the website into `site/` (`npm run build:web`). |
| `web/pdf.js`, `web/ocr-platform.js`, `web/shims/` | Browser versions of the few parts that need Node (opening PDFs, OCR settings, canvas, zlib, crypto). |
| `.github/workflows/pages.yml` | Publishes the website to GitHub Pages on every push to `main`. |

## Credits

The XTC output follows [XTC.js](https://github.com/varo6/xtcjs) (MIT License) for its image steps and file layout, checked against the XTC reader of the [CrossPoint Reader](https://github.com/crosspoint-reader/crosspoint-reader) firmware.
