### How to use
1)  Download repo
2)  Double-click "Play"
3)  Enjoy!  (Optional)

### Purpose
This program is intended as a supplement to the paper "Related Classes of Positions in the Game of Sprouts" (currently unpublished).  This app is *not* intended to be part of the paper, but in developing the app, several people said that it helped them understand the paper better, so I'm packaging them together with the hope that they complement each other.  Just remember: if in doubt, trust the math, not this app.

### Disclaimer
This app is still in development.  If you find any issues, please email andrew.lloyd.shue@gmail.com with a description of the issue, along with the save file.

### Background
This program is written based on an extensive math paper, which is still going through the peer review and publishing process (by which I mean, I'm still looking for a journal to publish).  In turn, that paper was based on properties of Sprouts that I discovered based on a Python program I'd written for the specific purpose of studying the game.  Both the paper and the original program were produced entirely by hand (or by keyboard, as it were); in fact, my work started back in 2021; years before the notion of AI coding even existed.  While I have repeatedly verified the results and can ensure that its output is flawless, the code itself is in a word, jank.  I've provided it in this repo ("stalks-original.ipynb") solely as documentation, but I would not recommend that anybody try to use it.  

The rest of this code was developed with Claude, using a mix of both Sonnet 4.6 and Opus 4.8.  The math-heavy back-end is called "Stalks", and is effectively a refactor of my old code with an extra algorithm or two thrown in to speed things up, as well as documentation that better aligns with my paper's lexicon (names of concepts changed while writing the paper, and I think the only surviving terms are "region" and "enclosure").  The canon positions and nimbers in the new code are all 1-to-1 matches with the original code.  I will stake my reputation on that code providing accurate results.

The front-end is called "Sprouts," and is entirely new; visuals and UI are not my strong suit, so exactly 0% of the code is by me.  That said, Claude struggles with both visuals and any underlying graph theory, so I still had to hand-hold it every step of the way.  There are still aspects of the code that are unreliable or broken, and not for lack of effort on our part; managing Sprouts UI is almost (almost!) as impossible as the underlying math.  The general rule is: if you're not actively trying to break it, you're probably fine.  But if you're too overzealous with dragging points around or are trying to set up deliberately complicated gamestates, there's a solid chance that you'll manage to break the thing.  

For those wondering, no, I don't recall why I called my program "Stalks."  I think it has something to do with the fact that the joints use Dyck Paths to generate stacks, or the diagram I'd made for myself was somehow stalk-like...  but I might be making that up in my head.
