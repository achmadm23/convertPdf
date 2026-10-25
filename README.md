# convertPdf

**Use it at [baca-baca.pages.dev](https://baca-baca.pages.dev/)**: nothing to install, on Windows, macOS, Linux, a tablet or a phone's browser.

Convert PDFs into EPUB e-books. It works on normal PDFs and on scanned books, with or without a text layer: pages that are only pictures of text are read with OCR. The converter:

- rebuilds real paragraphs and joins sentences that break across pages
- removes running headers, footers and page numbers
- splits the book into its real chapters, with section headings in the table of contents
- keeps the pictures (photos, charts, diagrams) where they appear in the text, and uses a picture-only first page as the cover
- lets you use a picture of your own as the cover instead
- puts the pictures in the text, with the text above and below each one, or each on a page of its own that it fills; the cover and pages kept as a picture fill a page, all in the 4 shades of gray of an e-ink screen, sized for your reader: 480 x 800 for the Xteink X4 and X4 Pro, 528 x 792 for the X3; for a Kindle, a Kobo or a phone they're kept full size, in color when they have it
- leaves the font to the e-reader, so the book reads in the font and size you choose there
- reads scanned pages with built-in OCR (English and Indonesian), with nothing extra to install
- also makes books of web pages such as news articles from BBC or Kompas: paste their links, and each becomes a book (see [Web pages](#web-pages-news-articles))

It converts inside your browser: your PDFs are never uploaded anywhere.

## How to use it

Open **[baca-baca.pages.dev](https://baca-baca.pages.dev/)**. The first scanned book downloads the OCR language data (about 4 MB, kept by the browser afterwards). The page is a reading room: the book you're working on in the middle, as your e-reader shows it, with its title and **Download** at the top; your books in a column on the left; and a rail of tools on the right that opens one drawer beside the book. It makes EPUBs.

**Add books.** At the top of the books, choose **PDFs** (books, documents and scans) or **Web pages** (news articles and other pages, [Web pages](#web-pages-news-articles)); each has its own books and its own settings for new books. Before the first book, the middle is one card: the reader, and the PDFs (or links). Drop PDFs on the page, as many as you like, or click **Add PDFs** above the books; paste links, one per line or separated by commas, in the card or with **Add links**. Each PDF and link becomes a book in the list. **«** folds the list to a strip of covers, **»** opens it again, and the page remembers which. A link shows its article's title and main picture straight away, so you can tell them apart while they wait.

**They're made one after another**, as soon as they're added. Each book in the list shows its cover once it's made, and its state: Waiting, Making with its progress, Paused, Ready (or "Ready · check 6 pages" for a scanned book with pages read badly), or why it could not be made (open it for **Try again**). Above them are how far along they all are and **Pause** for all of them (the book being made finishes, the rest wait until **Resume**); below them **Download all** (every book that's ready, in one zip) and the settings for new books (**Change**).

**Each book has Pause and Delete** beside it, and **Download** (↓) once it's ready: it saves that book, with any changes waiting put in it first, without opening it. Pausing a book that's waiting sets it aside; pausing the one being made stops it at its next step, and the next book starts. A paused book is made from the start when you **Resume** it. A book being made can't be deleted: pause it first, then delete it. Deleting a book that's made asks first.

**Click a book** to open it in the middle, while the others are still being made. A book that's ready is shown on an e-reader laid out at your reader's screen size, as big as the window allows, so lines and picture pages fall roughly as they will on the device; its own font and margins may differ a little. Move through it with the **slider**, which stops at every screen of the book, the arrow buttons or keys, and hold it in **Portrait** or **Landscape**. Beside it is **Check before you download**: its chapters, pages read badly, pages with pictures and the cover, each with a button that opens where it's checked. A book being made shows each step and about how long is left.

The rail opens these in the drawer, one at a time (click it again, or ×, to close it):

- **Pages** (scanned books): the book's pages, to fix ([below](#pages-the-pdf-page-beside-the-book)).
- **Chapters:** the book's contents, to change.
- **Cover:** the title and author (taken from the PDF or the article if left blank), and the cover: a picture of your own (JPEG, PNG or WebP, up to 20 MB, or drop one on it), **Use page 1** (the PDF's first page as the cover, its text left out of the book), or **Remove**.
- **Output:** your reader (Xteink X4 / X4 Pro, X3, or Kindle, Kobo or phone), and the pictures. An EPUB's pictures and cover are drawn for an Xteink's screen; for a Kindle, a Kobo or a phone they're kept full size (up to 1240 x 1680), in color when they have it and in smooth grays otherwise, for the reader to fit to its own screen. **Pictures** puts them **In the text** or each **On their own page**; **Full-page pictures** keeps portrait pictures that fill most of their page upright, or turns them on their side, cut into parts that each fill the screen. **Use these settings for all PDF books** (or **web page books**) gives every book of the list this one's reader and pictures; **Remove this book from the list** is at the bottom.

**Chapters** lists the book's contents: click one to go to it. For an EPUB of a PDF, the chapters follow the book's own table of contents (Daftar Isi) when it has one: it's looked for in the first 20 and last 10 pages, and used when it lists 5 or more chapters with page numbers whose titles are found in the book. **Find the Daftar Isi** looks for it again, and **Make them without it** makes the chapters as the converter finds them. Each entry's title and page number ("Bandung di Ujung Malam - 181") make a chapter that starts on that page, found from the page numbers printed on the pages; entries that can't be found are listed. To choose the chapters yourself, each one has **✎** to rename it and **×** to remove it (its pages join the chapter before, and its heading becomes ordinary text there, so it isn't a section of that chapter or in the contents; no page or text leaves the book, and adding its page again brings it back). A heading inside a chapter (a section, shown indented) has **×** too: it stays in the book as ordinary text. **Add page … to the contents** starts one at a PDF page, and in **Pages**, **Start a chapter here** starts one on the page open, with the name you type.

**Changes go in by themselves.** A change that builds the book again (a page fixed, the chapters, the Daftar Isi, page 1 as the cover, another reader) goes in a moment after the last one, never while you're typing: "Updating the book…" shows above it, then what went in. Only the pages a change touches are drawn again, so it's quick, and the pages aren't read with OCR again, so your fixes stay. **Download**, **Send** and **Download all** wait for it, so the file always has your changes.

**Turn and size a picture on the book:** click a picture of a PDF book in the preview. It's outlined, with a handle on each bottom corner: drag one out or in to make the picture bigger or smaller (it stays centred, from 20% to the full width of the screen). The bar on it turns it a quarter left (**↺**) or right (**↻**), or puts it back as it was found (**⟲**). It's shown so at once and goes in the book a moment later.

**Books aren't kept** after the page is closed or reloaded: download them first. The page asks before you leave while a book isn't downloaded.

### Pages: the PDF page beside the book

For a PDF book, **Pages** opens a list of its pages in the drawer: every page, the pages with their own text in the PDF too (marked **PDF text**: their text is fixed like a scanned page's, in **Text on this page** or typed into on the book, the pictures staying between the paragraphs they were between; their pictures are boxed on the page and turned and sized on the book, they can start a chapter or be kept as a picture; Read again is for scanned pages); each with its scan, number, how well it was read and the start of its text, once they're all read (until then it says how far the reading has got). It lists every page; **Read at 90% or lower** and **With pictures** show just the pages to check first. Pick one and the middle shows **the PDF page beside the book**, the same height, and the book turns to where that page's text starts. **‹ ›** under the PDF page ("Page 3 of 30") go to the page before or after, through every page of the book, each with all its tools. The book's own ‹ › sit right under it, level with the page's, and go only through the screens holding that page's text ("screen 1 of 2", between them) and stop at its start and end; Portrait / Landscape are below them; the slider is hidden while Pages is open. Each has its tools above it. Once the book is made:

- **Fix the text on the book:** click a paragraph of the book and type; **Enter** is done, **Esc** puts it back. Your text goes in that page's text (a paragraph that runs on into the next page is split back between them), and the book is updated a moment later. **Text on this page**, under the PDF page, has the page's whole text, for what can't be fixed on the book.
- **Done**, on a scanned page read at 75% or lower: the page is checked, so it's no longer counted or listed as one to check, and the next one to check opens. **Not done** undoes it.
- **Read again** reads the page with other settings (higher resolution, black and white, the page as one block of text) and keeps the best reading if it's better than the first.
- **Keep as picture**, instead of its text: for a handwritten letter, a table, or a page OCR garbles. **Whole** keeps it upright; **2 parts** or **3 parts** turn it on its side and cut it into halves, or thirds that overlap a little: each part fills the screen, so the text is bigger. **Use its text** undoes it. A first page kept whole as a picture becomes the book's cover.
- **Pictures, on the page itself:** the pictures found on the page are boxed on it, and changed right there: drag across the page to box one that was missed, drag a box to move it or its corner to resize it, and × removes it. While boxes are changed, **Apply pictures** and **Cancel** take the place of the page's tools: Apply puts what's in the boxes in the book as pictures (on a scanned page the text around them is read again), Cancel puts the boxes back as they were. Opening another page applies them too. **Remove all pictures** makes the whole page text; **Use found pictures** goes back to the ones the converter found.
- **Start a chapter here** (above the book) starts a chapter on the page, with the name you type; on a page a chapter starts on, it's **Rename chapter**, and **Remove chapter** joins its pages to the chapter before (the pages stay in the book).

**‹** and **Next to check** go from one page read at 75% or lower to the next. Pages read below 30% are marked as mostly pictures (a cover, for example).

## Web pages (news articles)

Choose **Web pages** at the top and paste the links of news articles or other web pages, one per line or separated by commas, for example a BBC News Indonesia or Kompas article. The converter downloads each page and keeps only the article, the way Firefox's Reader View does it ([Mozilla Readability](https://github.com/mozilla/readability)):

- the book has the article's title, then the site, author and date, its text with its subheadings in the contents, and its link at the end
- its pictures are drawn for your reader's screen in 4 shades of gray, in the text with their captions below them (or each on a page of its own)
- menus, ads, share buttons, "Most read" boxes and "Read also" links are left out
- the cover is the article's main picture (if it has one) with the book's title and author under it, drawn for the reader's screen; the picture is not repeated inside. Changing the title or author in **Cover** draws it again; you can choose a picture of your own instead, as for a PDF
- the book is marked with the article's language, for example Indonesian or English

Each link becomes a book of its own, named after its article, and goes in the list of web page books, made one after another. Each book takes its own article's title, author and cover, which can be changed like a PDF's. A link that can't be read (a site that refuses, a page with no article) is marked in the list with the reason, with **Try again**, and the other links are still made into books.

News sites don't let other websites read their pages, so the website fetches them through its own small function on Cloudflare (`functions/api/page.js`), which passes on web pages and pictures only, for the website itself; the article is read in your browser. Pages behind a paywall or a login only give what they show without it, and a site that turns away Cloudflare's servers can't be read.

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
- **Scanned books without a text layer** need OCR, about 1 to 2 seconds per page in the browser, depending on your computer, so a 244-page book takes several minutes. Keep the tab open while it reads.

## Limitations

- **OCR languages:** only English and Indonesian are included (see [Scanned books](#scanned-books-ocr) to add more).
- **Chapters are found by heading size**, or on scans by where the text starts. A PDF with neither falls back to chapters of 10 pages.
- **Text quality depends on the PDF.** In scanned books, recognition errors (for example a "1" read as "i") come through as they are.
- **Layout:** multi-column layouts and tables come out as plain paragraphs.
- **Pictures:** pages that are mostly pictures, such as ads at the back of a book, are kept as pictures.
- **Web pages:** the article is found from the page's layout, so on some sites a line that isn't part of it can remain, or a part of it can be missing. Pages that show their text only after scripts run, or only to subscribers, can't be read.

## For developers

The website is built from this repository and published on every push to `main`: to Cloudflare Pages at [baca-baca.pages.dev](https://baca-baca.pages.dev/) (`.github/workflows/cloudflare.yml`, with the web page function in `functions/`), and to GitHub Pages (`.github/workflows/pages.yml`, without web pages). To build it yourself, run `npm run build:web`; `npx wrangler pages dev site` serves it with its function.

The same converter also runs as a local web app and a command-line tool, with [Node.js](https://nodejs.org/) 22.23.4, 24.22.1 or 26.12.1 or newer in the same line:

```
git clone https://github.com/achmadm23/convertPdf.git
cd convertPdf
npm install
npm start                     # the web app at http://localhost:3000 (PORT=8080 npm start for another port)
```

The server keeps the last 20 books of PDFs and 50 books of web pages in memory, so each can still be changed and downloaded. Restarting the server clears them; the page then makes its books again from what the browser kept, as after a reload. The local app is faster on big scanned books (OCR on all the computer's cores).

### Command line

```
node index.js input.pdf [output.epub] [--title "Title"] [--author "Author"] [--cover image] [--device x4|x4-pro|x3|any] [--picture-parts 2|3] [--pictures inline|page] [--ocr-lang code]
```

If you leave out `output.epub`, the EPUB is saved next to the PDF with the same name.

`--cover` uses a picture (JPEG, PNG or WebP) as the book's cover instead of the PDF's first page.

`--device` sizes the book's pictures and cover for that e-reader's screen: `x4` and `x4-pro` (480 x 800, the default) or `x3` (528 x 792); `any` (a Kindle, a Kobo or a phone) keeps them full size (up to 1240 x 1680), in color when they have it, for the reader to fit to its own screen.

`--picture-parts 2` or `3` turns full-page portrait pictures on their side and cuts them into 2 or 3 parts that each fill the screen.

`--pictures page` puts each picture on a page of its own that it fills, instead of in the text with the text above and below it (`inline`, the default). Pictures turned on their side are always pages of their own.

`--ocr-lang` sets the language of scanned pages: `eng` (English) or `ind` (Indonesian). Without it, the converter tries both on a few pages and uses the one it reads best.

```
node index.js "Homo Deus.pdf"
node index.js book.pdf book.epub --title "My Book" --author "Jane Doe" --cover cover.jpg
```

For web pages, give their links instead of a PDF, separated by spaces or commas. Each one becomes a book of its own, made one after another and named after its article. With one link, `output.epub` is the file; with several, the output is a folder for the books. Without it, they're saved in the current folder. A link that can't be read is skipped and the others are still made.

```
node index.js https://... [more links] [output.epub, or a folder for several] [--title ...] [--author ...] [--cover image] [--device x4|x4-pro|x3|any]
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

### Xteink books (XTC)

For Xteink readers (X3, X4 and X4 Pro), convertPdf can also make an XTC book: every PDF page drawn ready for the reader's screen, the way [XTC.js](https://xtcjs.app/pdf) does. Use `--format xtc` on the command line. Pages keep their layout exactly as in the PDF, so this suits manga, comics, scans and PDFs with tables, columns or formulas. The text isn't rebuilt or read with OCR.

| Setting | Choices |
|---|---|
| Device | Xteink X4 and X4 Pro (480 x 800), Xteink X3 (528 x 792) |
| Shades | Black and white (`.xtc`, faster page turns) or 4 shades of gray (`.xtch`, better for photos and shading) |
| Pages | **Sideways** (the default): each page is turned on its side so its text is bigger, and cut into 3 or more overlapping parts, 2 halves, or not cut. **Upright**: each page whole. |
| More settings | Dithering (Atkinson, Floyd-Steinberg, Sierra Lite, Ordered or none), contrast, trimming wide margins, whether the first page is the cover (shown whole and upright), and which way sideways pages turn |

The PDF's bookmarks become the book's chapters, and its title and author are kept. A cover picture of your own replaces the first page when that is the cover, or comes before it otherwise. The preview shows each page as the reader will.

### Project layout

| File | What it does |
|---|---|
| `index.js` | Reads the PDF, builds paragraphs and chapters, writes the EPUB. Also the command-line tool. |
| `figures.js` | Finds and crops pictures, and renders the cover (from the PDF or a picture you choose). |
| `picture-pages.js` | In the app, finds the pictures on several pages at once, in worker threads (up to 4); the website does them one by one. |
| `eink.js` | Turns pictures into full-screen e-ink pages (480 x 800, 4 shades of gray, dithered). |
| `ocr.js` | Reads scanned pages with OCR (Tesseract). |
| `ocr-platform.js` | Where OCR finds its language data and how many pages it reads at once (the app's settings). |
| `xtc.js` | Draws PDF pages for an Xteink screen (fit or split, contrast, dithering) and makes the XTC book. |
| `xtcfile.js` | The XTC/XTCH file format: page encoding (XTG, XTH) and the book file. |
| `pdf.js` | Opens a PDF with pdf.js. |
| `web.js` | Web pages into a book: downloads each page, finds its article (Mozilla Readability), and gets its pictures. |
| `server.js` | Local web server for the web app. |
| `public/index.html` | The web app page: the list of books converted one after another, the e-reader preview with its slider, each book's settings, and the scanned pages. |
| `web/api.js` | The website's converter: the server's work, done in the browser. |
| `web/build.js` | Builds the website into `site/` (`npm run build:web`). |
| `web/pdf.js`, `web/ocr-platform.js`, `web/shims/` | Browser versions of the few parts that need Node (opening PDFs, OCR settings, canvas, reading web pages, zlib, crypto). |
| `functions/api/page.js` | The website's function on Cloudflare: fetches a web page or picture for it, since news sites don't let other websites read their pages. |
| `.github/workflows/cloudflare.yml` | Publishes the website to Cloudflare Pages (baca-baca.pages.dev) on every push to `main`. |
| `.github/workflows/pages.yml` | Publishes the website to GitHub Pages too (without web pages). |

## Credits

The XTC output follows [XTC.js](https://github.com/varo6/xtcjs) (MIT License) for its image steps and file layout, checked against the XTC reader of the [CrossPoint Reader](https://github.com/crosspoint-reader/crosspoint-reader) firmware.
