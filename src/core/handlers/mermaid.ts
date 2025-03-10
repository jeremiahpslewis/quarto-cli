/*
* mermaid.ts
*
* Copyright (C) 2022 by RStudio, PBC
*
*/

import {
  LanguageCellHandlerContext,
  LanguageCellHandlerOptions,
  LanguageHandler,
} from "./types.ts";
import { baseHandler, install } from "./base.ts";
import { formatResourcePath } from "../resources.ts";
import { join } from "path/mod.ts";
import {
  isJavascriptCompatible,
  isLatexOutput,
  isMarkdownOutput,
  isRevealjsOutput,
} from "../../config/format.ts";
import { QuartoMdCell } from "../lib/break-quarto-md.ts";
import { asMappedString, mappedConcat } from "../lib/mapped-text.ts";
import {
  fixupAlignment,
  makeResponsive,
  resolveSize,
  setSvgSize,
} from "../svg.ts";
import {
  kFigAlign,
  kFigHeight,
  kFigResponsive,
  kFigWidth,
  kMermaidFormat,
} from "../../config/constants.ts";
import { Element } from "../deno-dom.ts";
import { convertFromYaml } from "../lib/yaml-schema/from-yaml.ts";
import { readYamlFromString } from "../yaml.ts";
import { pandocHtmlBlock, pandocRawStr } from "../pandoc/codegen.ts";
import { LocalizedError } from "../lib/error.ts";
import { warning } from "log/mod.ts";
import { FormatDependency } from "../../config/types.ts";
import { mappedDiff } from "../mapped-text.ts";

const mermaidHandler: LanguageHandler = {
  ...baseHandler,

  schema() {
    return Promise.resolve(convertFromYaml(readYamlFromString(`
object:
  properties:
    mermaid-format:
      enum: [png, svg, js]
`)));
  },

  type: "cell",
  stage: "post-engine",

  languageName: "mermaid",
  languageClass: (options: LanguageCellHandlerOptions) => {
    if (isMarkdownOutput(options.format.pandoc, ["gfm"])) {
      return "mermaid-source"; // sidestep github's in-band signaling of mermaid diagrams
    } else {
      return "default"; // no pandoc highlighting yet so we use 'default' to get grey shading
    }
  },

  defaultOptions: {
    echo: false,
    eval: true,
    include: true,
  },

  comment: "%%",

  async cell(
    handlerContext: LanguageCellHandlerContext,
    cell: QuartoMdCell,
    options: Record<string, unknown>,
  ) {
    const cellContent = handlerContext.cellContent(cell);
    // create puppeteer target page
    const content = `<html>
<head>
<script src="./mermaid.min.js"></script>
</head>
<body>
<pre class="mermaid">\n${cellContent.value}\n</pre>
<script>
mermaid.initialize();
</script>
</html>`;
    const selector = "pre.mermaid svg";
    const resources: [string, string][] = [[
      "mermaid.min.js",
      Deno.readTextFileSync(
        formatResourcePath("html", join("mermaid", "mermaid.min.js")),
      ),
    ]];

    const setupMermaidJsRuntime = () => {
      if (handlerContext.getState().hasSetupMermaidJsRuntime) {
        return;
      }
      handlerContext.getState().hasSetupMermaidJsRuntime = true;

      const jsName =
        handlerContext.options.context.format.metadata?.["mermaid-debug"]
          ? "mermaid.js"
          : "mermaid.min.js";

      const dep: FormatDependency = {
        name: "quarto-diagram",
        scripts: [
          {
            name: jsName,
            path: formatResourcePath("html", join("mermaid", jsName)),
          },
          {
            name: "mermaid-init.js",
            path: formatResourcePath(
              "html",
              join("mermaid", "mermaid-init.js"),
            ),
            afterBody: true,
          },
        ],
        stylesheets: [
          {
            name: "mermaid.css",
            path: formatResourcePath("html", join("mermaid", "mermaid.css")),
          },
        ],
      };
      handlerContext.addHtmlDependency(dep);
    };

    const makeFigLink = (
      sourceName: string,
      width?: number,
      height?: number,
      includeCaption?: boolean,
    ) => {
      const posSpecifier = isLatexOutput(handlerContext.options.format.pandoc)
        ? " fig-pos='H'"
        : "";
      const idSpecifier = (cell.options?.label && includeCaption)
        ? ` #${cell.options?.label}`
        : "";
      const widthSpecifier = width
        ? `width="${Math.round(width * 100) / 100}in"`
        : "";
      const heightSpecifier = height
        ? ` height="${Math.round(height * 100) / 100}in"`
        : "";
      const captionSpecifier = includeCaption
        ? (cell.options?.["fig-cap"] || "")
        : "";

      return `\n![${captionSpecifier}](${sourceName}){${widthSpecifier}${heightSpecifier}${posSpecifier}${idSpecifier}}\n`;
    };
    const responsive = handlerContext.options.context.format.metadata
      ?.[kFigResponsive];

    const makeSvg = async () => {
      let svg = asMappedString(
        (await handlerContext.extractHtml({
          html: content,
          selector,
          resources,
        }))[0],
      );

      const fixupRevealAlignment = (svg: Element) => {
        if (isRevealjsOutput(handlerContext.options.context.format.pandoc)) {
          const align = (options?.[kFigAlign] as string) ?? "center";
          fixupAlignment(svg, align);
        }
      };

      let newId: string | undefined = undefined;
      const idsToPatch: string[] = [];

      const fixupMermaidSvg = (svg: Element) => {
        // replace mermaid id with a consistent one.
        const { baseName: newMermaidId } = handlerContext.uniqueFigureName(
          "mermaid-figure-",
          "",
        );
        newId = newMermaidId;
        fixupRevealAlignment(svg);
        const oldId = svg.getAttribute("id") as string;
        svg.setAttribute("id", newMermaidId);
        const style = svg.querySelector("style")!;
        style.innerHTML = style.innerHTML.replaceAll(oldId, newMermaidId);

        for (const defNode of svg.querySelectorAll("defs")) {
          const defEl = defNode as Element;
          // because this is a defs node and deno-dom doesn't like non-html elements,
          // we can't use the standard API
          const m = defEl.innerHTML.match(/id="([^\"]+)"/);
          if (m) {
            const id = m[1];
            idsToPatch.push(id);
          }
        }
      };

      if (
        responsive && options[kFigWidth] === undefined &&
        options[kFigHeight] === undefined
      ) {
        svg = await makeResponsive(svg, fixupMermaidSvg);
      } else {
        svg = await setSvgSize(svg, options, (svg: Element) => {
          // mermaid comes with too much styling wrt to max width. remove it.
          svg.removeAttribute("style");

          fixupMermaidSvg(svg);
        });
      }

      // This is a preposterously ugly fix to a mermaid issue where
      // duplicate definition ids are emitted, which causes diagrams to step
      // on one another's toes.
      if (idsToPatch.length) {
        let oldSvgSrc = svg.value;
        for (const idToPatch of idsToPatch) {
          const to = `${newId}-${idToPatch}`;
          // this string substitution is fraught, but I don't know how else to fix the problem.
          oldSvgSrc = oldSvgSrc.replaceAll(
            `"${idToPatch}"`,
            `"${to}"`,
          );
          oldSvgSrc = oldSvgSrc.replaceAll(
            `#${idToPatch}`,
            `#${to}`,
          );
        }
        svg = mappedDiff(svg, oldSvgSrc);
      }

      if (isMarkdownOutput(handlerContext.options.format.pandoc, ["gfm"])) {
        const { sourceName, fullName } = handlerContext
          .uniqueFigureName(
            "mermaid-figure-",
            ".svg",
          );
        Deno.writeTextFileSync(fullName, svg.value);

        const {
          widthInInches,
          heightInInches,
        } = await resolveSize(svg.value, options);

        return asMappedString(
          makeFigLink(sourceName, widthInInches, heightInInches, true),
        );
      } else {
        return this.build(
          handlerContext,
          cell,
          svg,
          options,
          undefined,
          new Set(["fig-width", "fig-height", "mermaid-format"]),
        );
      }
    };

    const makePng = async () => {
      const {
        filenames: [sourceName],
        elements: [svgText],
      } = await handlerContext.createPngsFromHtml({
        prefix: "mermaid-figure-",
        selector,
        count: 1,
        deviceScaleFactor: Number(options.deviceScaleFactor) || 4,
        html: content,
        resources,
      });

      const {
        widthInInches,
        heightInInches,
      } = await resolveSize(svgText, options);

      if (isMarkdownOutput(handlerContext.options.format.pandoc, ["gfm"])) {
        return asMappedString(makeFigLink(
          sourceName,
          widthInInches,
          heightInInches,
          true,
        ));
      } else {
        return this.build(
          handlerContext,
          cell,
          asMappedString(makeFigLink(
            sourceName,
            widthInInches,
            heightInInches,
          )),
          options,
          undefined,
          new Set(["fig-width", "fig-height", "mermaid-format"]),
        );
      }
    };

    // deno-lint-ignore require-await
    const makeJs = async () => {
      setupMermaidJsRuntime();
      const { baseName: tooltipName } = handlerContext
        .uniqueFigureName(
          "mermaid-tooltip-",
          "",
        );
      const preEl = pandocHtmlBlock("pre")({
        classes: ["mermaid"],
        attrs: [`tooltip-selector="#${tooltipName}"`],
      });
      preEl.push(pandocRawStr(cell.source));

      const attrs: Record<string, unknown> = {};
      if (isRevealjsOutput(handlerContext.options.context.format.pandoc)) {
        attrs.reveal = true;
      }

      return this.build(
        handlerContext,
        cell,
        mappedConcat([
          preEl.mappedString(),
          `\n<div id="${tooltipName}" class="mermaidTooltip"></div>`,
        ]),
        options,
        attrs,
        new Set(["mermaid-format"]),
      );
    };

    const makeDefault = async () => {
      if (isJavascriptCompatible(handlerContext.options.format)) {
        return await makeJs();
      } else if (
        isMarkdownOutput(handlerContext.options.format.pandoc, ["gfm"])
      ) {
        return mappedConcat(["\n``` mermaid\n", cellContent, "\n```\n"]);
      } else {
        return await makePng();
      }
    };

    const format = options[kMermaidFormat] ||
      handlerContext.options.format.execute[kMermaidFormat];

    if (format === "svg") {
      return await makeSvg();
    } else if (format === "png") {
      return await makePng();
    } else if (format === "js") {
      if (!isJavascriptCompatible(handlerContext.options.format)) {
        const error = new LocalizedError(
          "IncompatibleOutput",
          `\`mermaid-format: js\` not supported in format ${
            handlerContext.options.format.pandoc.to ?? ""
          }`,
          cell.sourceVerbatim,
          0,
        );
        warning(error.message);
        console.log("");
        return await makeDefault();
      } else {
        if (isRevealjsOutput(handlerContext.options.context.format.pandoc)) {
          const error = new LocalizedError(
            "NotRecommended",
            `\`mermaid-format: js\` not recommended in format ${
              handlerContext.options.format.pandoc.to ?? ""
            }`,
            cell.sourceVerbatim,
            0,
          );
          warning(error.message);
          console.log("");
        }
        return await makeJs();
      }
    } else {
      return await makeDefault();
    }
  },
};

install(mermaidHandler);
