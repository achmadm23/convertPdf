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
- in the app, also makes books of web pages such as news articles from BBC or Kompas: paste their links, and each becomes a book (see [Web pages](#web-pages-news-articles))

It runs entirely on your computer. Your files are never uploaded anywhere.

## Use it online

**[Open convertPdf](https://achmadm23.github.io/convertPdf/)** in your browser: nothing to install, on Windows, macOS, Linux, or a tablet.

The website does everything the app does except books of web pages, and the converting happens inside your browser: your PDF is never uploaded. It's slower than the app on big scanned books, because OCR uses your browser instead of all your computer's cores, and the first scanned book downloads the OCR language data (about 4 MB, kept by the browser afterwards).

The site is published from this repository by GitHub Pages: every push to `main` rebuilds it (`.github/workflows/pages.yml`). To build it yourself, run `npm run build:web` and serve the `site/` folder.

## Download (Windows, no install)

**[Download ConvertPdf.zip](https://github.com/achmadm23/convertPdf/releases/download/v1.3.0/ConvertPdf.zip)** (63 MB)

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

If you use `ConvertPdf.exe`, [download the zip](https://github.com/achmadm23/convertPdf/releases/download/v1.3.0/ConvertPdf.zip) again instead.

## Web app (upload, preview, download)

```
npm start
```

Then open **http://localhost:3000**. First choose what you convert at the top: **PDF** (books, documents and scans) or **Web pages** (news articles and other pages, [Web pages](#web-pages-news-articles)). Each has its own list of books, its own settings for new books and its own **Download all**; the number on each tab is how many books it has. Below it, the page has three columns: that source's books on the left, the book you click in the middle, and its settings on the right.

**Add books.** On **PDF**, drop PDFs on the page, as many as you like, or click **Add PDFs** at the top. On **Web pages**, paste links, one per line or separated by commas: in the box shown before the first book, then with **Add links** at the top. Each PDF and link becomes a book of its own in the list on the left. A PDF dropped while Web pages is shown, or a link while PDF is shown, goes to its own tab.

**They're converted one after another**, as soon as they're added, the books of both tabs in the order they were added. Each line in the list shows its book's state: Waiting, Converting with its progress, Ready (or "Ready · check 6 pages" for a scanned book with pages read badly), or why it could not be made, with **Try again**. Above the list are how far along they all are and **Pause**, which lets the book being made finish and stops there until you click **Resume**.

**Click a book** to see it in the middle and change it on the right, while the others are still being made. A book that's ready is shown on an e-reader laid out at your reader's screen size (480 x 800 on an X4 Pro), so lines and picture pages fall roughly as they will on the device; its own font and margins may differ a little. Move through it with the **slider** under the reader, which has a stop for every screen of the book, picture pages included, with the arrow buttons or keys, and hold it in **Portrait** or **Landscape**. A book being converted shows each step and about how long is left, for example "Reading scanned pages: 57 of 244".

**Its settings** are in four sections; each shows its current choice when closed:

1. **Details:** the title and author, taken from the PDF or the article if you leave them blank. A change goes in the book at once. The book's contents are here too: click a chapter to go to it.
2. **Cover:** a picture of your own (JPEG, PNG or WebP, up to 20 MB), or drop one on it. It replaces the cover taken from the PDF or the article; **Remove** goes back to it.
3. **Reader and pictures:** your e-reader (Xteink X4 Pro, X4 or X3). An EPUB's pictures and cover are drawn for its screen. **Full-page pictures** chooses how portrait pictures that fill most of their page go in the book: upright, or turned on their side and cut into **2** or **3 parts** that each fill the screen, as in an XTC book. Changing it updates the book at once.
4. **Output:** an EPUB for any e-reader, or for a PDF an XTC book for an Xteink reader ([Xteink books](#xteink-books-xtc)), with its settings. Web pages always become an EPUB.

Another reader or output converts the book again: **Convert this book again** appears, and the book takes its place in the list. **Use these settings for all PDF books** (or **web page books**) gives every book of the tab this one's reader, pictures and output (each keeps its own title, author and cover), converts again those made with others, and uses them for new books too. The settings for new books are under **Change**, below the list.

When a book looks right, click **Download** under its settings. **Download all** saves every book of the tab that's ready in one zip file. **Remove from the list** takes a book out.

The page works offline: its fonts are served by the converter.

For scanned books, a **Scanned pages** tab above the preview shows a card for each page as OCR reads it, even while the book is being converted: its scan, how well it was read, and the start of its text. Pages read at 75% or lower are marked; tick **Only pages at 90% or lower** to see just the ones worth checking. While the pages are shown, the right column is the **page editor**: click a card to open its page there, with its scan larger. Once the conversion has finished, it can:

- **Text of the page:** correct the text or type it yourself, looking at the scan above it, then **Save text**. Leave an empty line between paragraphs. Your text is used instead of what OCR read, and the page stays editable.
- **Read again** reads the page with other settings (higher resolution, black and white, the page as one block of text) and keeps the best reading if it's better than the first.
- **Keep the whole page as a picture** instead of its text: for a handwritten letter, a table, or a page OCR garbles. **Whole** keeps it upright; **2 parts** or **3 parts** turn it on its side and cut it into halves, or thirds that overlap a little, as in an XTC book: each part fills the screen, so the text is bigger. Turn your e-reader on its side to read them. **Use its text** undoes it. A first page kept whole as a picture becomes the book's cover.
- **Draw a box:** the pictures found on the page are marked on its scan with dashed boxes. When one was missed, cut short, or isn't a picture, drag across the page to draw a box around a picture, drag a box to move it or its corner to resize it, and × removes it. **Save pictures** puts what's inside the boxes in the book as pictures, and the text outside them stays text; with no boxes, the whole page is text. **Use found pictures** goes back to the ones the converter found.

**Previous low page** and **Next low page** go from one page read at 75% or lower to the next. To put every page read at 90% or lower in the book as a picture at once, click **Keep N pages at 90% or lower as pictures** above the cards and choose **Whole**, **2 parts** or **3 parts**; pages whose text you typed keep it. **Use the text of N pages kept as pictures** undoes it.

Then click **Update the book** to use the changed pages. This takes under a minute, because the other pages aren't read again. Pages read below 30% are marked as mostly pictures (a cover, for example).

The server keeps the last 20 books of PDFs and 50 books of web pages in memory, so each can still be changed and downloaded. Restarting the server clears them, and so does reloading the page: the list starts empty again.

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

For web pages, give their links instead of a PDF, separated by spaces or commas. Each one becomes a book of its own, made one after another and named after its article. With one link, `output.epub` is the file; with several, the output is a folder for the books. Without it, they're saved in the current folder. A link that can't be read is skipped and the others are still made.

```
node index.js https://... [more links] [output.epub, or a folder for several] [--title ...] [--author ...] [--cover image] [--device x4|x4-pro|x3]
node index.js https://www.bbc.com/indonesia/vert-cap-43738523
node index.js https://www.bbc.com/indonesia/...,https://nasional.kompas.com/read/... news
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

## Web pages (news articles)

In the app (`npm start` or `ConvertPdf.exe`), choose **Web pages** at the top and paste the links of news articles or other web pages, one per line or separated by commas, for example a BBC News Indonesia or Kompas article. The converter downloads each page and keeps only the article, the way Firefox's Reader View does it ([Mozilla Readability](https://github.com/mozilla/readability)):

- the book has the article's title, then the site, author and date, its text with its subheadings in the contents, and its link at the end
- its pictures are drawn for your reader's screen in 4 shades of gray, each on a page of its own, with their captions
- menus, ads, share buttons, "Most read" boxes and "Read also" links are left out
- the article's main picture is the cover, and is not repeated inside. You can choose another, as for a PDF
- the book is marked with the article's language, for example Indonesian or English

Each link becomes a book of its own, named after its article, and goes in the list of web page books, made one after another. Each book takes its own article's title, author and cover, which can be changed like a PDF's. A link that can't be read (a site that refuses, a page with no article) is marked in the list with the reason, with **Try again**, and the other links are still made into books.

Only the app can do this. The website can't: news sites don't let other websites read their pages. Pages behind a paywall or a login only give what they show without it.

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
- **Web pages:** the article is found from the page's layout, so on some sites a line that isn't part of it can remain, or a part of it can be missing. Pages that show their text only after scripts run, or only to subscribers, can't be read.

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
| `web.js` | Web pages into a book: downloads each page, finds its article (Mozilla Readability), and gets its pictures. Only in the app. |
| `server.js` | Local web server for the web app. |
| `public/index.html` | The web app page: the list of books converted one after another, the e-reader preview with its slider, each book's settings, and the scanned pages. |
| `build/build-exe.js` | Builds `ConvertPdf.exe` (`npm run build:exe`). |
| `build/launcher.js` | Start-up code inside the exe: unpacks the app and starts the server. |
| `web/api.js` | The website's converter: the server's work, done in the browser. |
| `web/build.js` | Builds the website into `site/` (`npm run build:web`). |
| `web/pdf.js`, `web/ocr-platform.js`, `web/shims/` | Browser versions of the few parts that need Node (opening PDFs, OCR settings, canvas, zlib, crypto). |
| `.github/workflows/pages.yml` | Publishes the website to GitHub Pages on every push to `main`. |

## Credits

The XTC output follows [XTC.js](https://github.com/varo6/xtcjs) (MIT License) for its image steps and file layout, checked against the XTC reader of the [CrossPoint Reader](https://github.com/crosspoint-reader/crosspoint-reader) firmware.
