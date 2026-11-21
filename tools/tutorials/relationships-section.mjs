export const projectRelationshipsSection = `
    <section id="relationships" data-chapter aria-labelledby="relationships-title">
      <div class="chapter-label">THE BIG PICTURE / HOW YOUR MUSIC FITS TOGETHER</div>
      <h2 id="relationships-title">Projects, tracks, clips &amp; scenes</h2>
      <figure class="relationship-figure">
        <section class="relationship-diagram" aria-label="XMP project relationship diagram; scroll sideways on a small screen">
          <img src="%BASE_URL%manual-media/project-relationships.svg" alt="Everything belongs to a project. A track uses one instrument and owns its clips. Scenes select clips across tracks. A song chain orders and repeats scenes. Kit and sampler pads reference the shared project sample pool.">
        </section>
        <figcaption>Tracks supply the sounds; clips store what to play. Scenes choose which clips play together. The song chain chooses the order of scenes. <a href="%BASE_URL%manual-media/project-relationships.svg" target="_blank" rel="noopener">Open the full-size diagram ↗</a></figcaption>
      </figure>
      <p class="relationship-scroll-hint">On a phone, swipe the diagram sideways to read every label.</p>
      <div class="table-scroll"><table><caption>A practical example: two tracks, two scenes</caption><thead><tr><th scope="col">Scene</th><th scope="col">Drums track · kit instrument</th><th scope="col">Synth track · synth instrument</th></tr></thead><tbody>
        <tr><th scope="row">Intro</th><td>Drum clip A</td><td>Synth clip A</td></tr>
        <tr><th scope="row">Verse</th><td>Drum clip B · a variation</td><td>Empty slot · stops this track</td></tr>
      </tbody></table></div>
      <p><strong>Song chain:</strong> Intro → Verse → Intro. Returning to Intro reuses the same clips. A scene references a clip; it does not make a copy. Editing a reused clip changes it in every scene that selects it.</p>
      <p><strong>Samples are sound; clips are performances.</strong> A recorded or imported sample goes into the project's sample pool. Kit pads assign those sounds or slices. Clips hold the notes, rhythm and automation that play the track's instrument.</p>
    </section>`;
