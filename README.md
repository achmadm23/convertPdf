# convertPdf

Convert PDFs that contain text into EPUB e-books. It works on normal PDFs and on scanned books that have a text layer. The converter:

- rebuilds real paragraphs and joins sentences that break across pages
- removes running headers, footers and page numbers
- splits the book into its real chapters, with section headings in the table of contents
- keeps the pictures (photos, charts, diagrams) where they appear in the text, and uses a picture-only first page as the cover
- embeds a font of your choice, or leaves the font to the e-reader

It runs entirely on your computer. Your files are never uploaded anywhere.

## Requirements

- [Node.js](https://nodejs.org/) 22.13 or newer (required by pdf.js)
- Windows, macOS or Linux (x64 or arm64). Page rendering uses `@napi-rs/canvas`, which ships prebuilt binaries for these systems.

## Install

```
git clone https://github.com/achmadm23/convertPdf.git
cd convertPdf
npm install
```

## Web app (upload, preview, download)

```
npm start
```

Then open **http://localhost:3000** and:

1. **Choose a PDF**, or drag it onto the page.
2. Optionally type a **title** and **author**. If you leave them blank, they're taken from the PDF.
3. Pick a **font**.
4. Click **Convert**. The progress bar shows what's happening, for example "Finding pictures: page 57 of 121".
5. **Preview** the book on the right. Turn pages with **‹ Prev / Next ›** or the arrow keys, and jump to a chapter from the contents list.
6. Change the font as often as you like. The preview updates in about a second, without converting again.
7. Click **Download**. The button stays disabled until the conversion has finished.

The server keeps the last 5 converted books in memory so you can change fonts quickly. Restarting the server clears them.

To use a different port:

```
PORT=8080 npm start          # macOS / Linux
$env:PORT=8080; npm start    # Windows PowerShell
```

## Command line

```
node index.js input.pdf [output.epub] [--title "Title"] [--author "Author"] [--font id]
```

If you leave out `output.epub`, the EPUB is saved next to the PDF with the same name.

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

## How long it takes

- **Normal PDFs:** a few seconds.
- **Scanned books with pictures** take longer, because pages that might hold a picture have to be rendered. A 540-page scanned book with 56 pictures takes about 2 minutes. The text itself takes a few seconds; the rest of the time is spent on pictures.

## Limitations

- **Scanned PDFs without a text layer** (pictures of pages only) can't be converted. Run them through OCR first.
- **Chapters are found by heading size.** A PDF whose chapter titles are the same size as its body text falls back to chapters of 10 pages.
- **Text quality depends on the PDF.** In scanned books, errors in the scan's text recognition (for example a "1" read as "i") come through as they are.
- **Layout:** multi-column layouts and tables come out as plain paragraphs.
- **Pictures:** pages that are mostly pictures, such as ads at the back of a book, are kept as pictures.

## Project layout

| File | What it does |
|---|---|
| `index.js` | Reads the PDF, builds paragraphs and chapters, writes the EPUB. Also the command-line tool. |
| `figures.js` | Finds and crops pictures, and renders the cover. |
| `fonts.js` | Font list and embedding. |
| `server.js` | Local web server for the web app. |
| `public/index.html` | The web app page (upload, progress, preview, font choice). |
