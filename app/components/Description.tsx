import { Fragment } from 'react'
import { parseDescription, type Line } from '../lib/description'

/**
 * An author's description at full length, in the shape they typed it (#43).
 *
 * Elements, not `dangerouslySetInnerHTML`: the text is author-supplied and
 * this is the one place it is rendered whole. The parser decides what is a
 * paragraph, a list or a link; nothing the author wrote can become markup.
 */
export function Description({ text, lang }: { text: string; lang?: string }) {
  const blocks = parseDescription(text)
  return (
    <div className="prose" lang={lang}>
      {blocks.map((block, index) => {
        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul'
          return (
            <List key={index}>
              {block.items.map((item, at) => <li key={at}><Runs line={item} /></li>)}
            </List>
          )
        }
        return (
          <p key={index}>
            {block.lines.map((line, at) => (
              <Fragment key={at}>
                {at > 0 && <br />}
                <Runs line={line} />
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}

function Runs({ line }: { line: Line }) {
  return (
    <>
      {line.map((run, index) => run.kind === 'link'
        // `nofollow ugc`: the link is the author's, and search engines should
        // treat it as such rather than as this site's recommendation.
        ? <a key={index} href={run.href} target="_blank" rel="noopener noreferrer nofollow ugc">{run.text}</a>
        : <Fragment key={index}>{run.text}</Fragment>)}
    </>
  )
}
