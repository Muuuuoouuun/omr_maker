# 문제·OMR 생성 패널 — 두 번째 시안

2026-09-10. 사용자 요청: “조금 더 디벨롭.”

내장 이미지 생성 도구로 이전 세 시안을 각각 발전시켰습니다. 아래 번호는 이번 응답에서 새 이미지가 표시된 순서입니다. 이전 시안과 앱 소스는 유지했습니다.

| 표시 순서 | 방향 | 이미지 | 발전시킨 내용 |
|---|---|---|---|
| 1 | 연결형 출제 워크벤치 | [01-linked-workbench.png](01-linked-workbench.png) | 전체 문항 이동, 선택 상태 연결, 시험 설정과 문항 설정 구분, 완료 표시 간소화 |
| 2 | 완성까지 안내하는 출제 데스크 | [02-guided-correction.png](02-guided-correction.png) | 미입력 문항 이동, 표 안에서 PDF 근거와 속성 펼치기, 학생용 OMR 확인 |
| 3 | 한 문항 집중 스튜디오 | [03-focus-studio.png](03-focus-studio.png) | 큰 문항 보기, 우측 설정, 하단 전체 OMR 이동 영역, 공통 지문 연결 |

## 참고 및 상태

- 각 생성에 해당하는 이전 시안 PNG와 실제 `public/logo.png`를 첨부했습니다.
- 기존 `src/app/create/page.tsx` 기능과 프로젝트의 인디고·Pretendard 디자인 방향을 바탕으로 만들었습니다.
- 요청 캔버스는 1440 × 1024입니다.
- 이미지 시안이며 실제 UI 구현·동작 검증 결과가 아닙니다. 작은 문항 번호와 마킹 라벨은 구현 시 정확하게 구성해야 합니다.

## 생성 프롬프트

### 1

Use case: ui-mockup. Produce ONE refined, production-quality desktop UI concept for the Korean teacher app OMR Maker. Concept name "연결형 출제 워크벤치". This is a second design pass on the attached previous concept, in response to "develop it further". Meaningfully refine workflow, composition and visual craft. Do not simply reskin it or add features.

Target:1440 x1024 desktop viewport, same landscape proportion as reference. App content only, no device/browser frame, external labels, concept number, perspective or collage. Current date2026-09-10; omit dates.
Reference1=previous three-pane design to refine. Reference2=real OMR Maker logo. Preserve Korean product identity, PDF + selected-question editing + OMR workflow, existing indigo#4f46e5, navy#0f172a, muted#64748b, light slate#f8fafc, white surfaces and hairlines#e2e8f0. Pretendard Korean14–16px body, 22–26px headings, precise numerals, optically aligned icons. Buttons radius8px, no shiny gradients, no diffuse purple glows, no giant pills. Refine with whitespace, grouping, typography and slim dividers before using containers. Only one primary CTA.

KEY EVOLUTION: wider readable PDF, contextual controls clearly separated from exam settings, immediate movement among all20questions, calm compact OMR overview without20 redundant green completion labels. Selection must be visibly synchronized across PDF, editing panel and OMR. Make it feel like an elegant professional desktop editor.

HEADER64px: small logo "OMR Maker", subtle divider, editable exam title "고1 국어 · 독서 평가" with tiny pencil, one quiet text line under title "20문항 · 5지선다 · 100점". Right muted "초안 저장됨", small undo/redo, secondary "초안 저장", single solid indigo "검토하고 배포" button. All aligned, no giant title input box and no second full-width metadata toolbar.
MAIN fromy64 to964: three flush panels: PDF560px, contextual editing480px, OMR400px, separated by thin resizable lines with small grips.
PDF PANEL: one concise white toolbar, "문제지" active underline and "참고 답지"; right small more icon. Secondary compact line filename "고1_국어_독서.pdf", page"3 / 5", zoom"100%". Charcoal-slate#363d4a canvas with a clean white document page occupying most available width. Realistic Korean reading exam content showing question11above and12below. Question12 linked region has fine indigo outline and a small "12번" tag. Its prompt: "다음 글의 중심 생각으로 가장 적절한 것은?" Passage about reading broadening perspective, answer3"좋은 독서는 사고의 폭을 넓혀 준다." Use readable short content, five choices, don't cram. At foot of PDF a small unobtrusive floating toolbar with page controls and "영역 조정"; no long explanatory text.
MIDDLE INSPECTOR: neat equal text tabs "문항 설정" active / "시험 설정", below section "문항 바로가기" and a20-number grid, exactly1–10firstrow,11–20secondrow. Buttons small38px, mostly plain number labels with pale neutral backgrounds;12solidindigo active,7and16amber outlined with small dot because missing. Beneath "12번 문항" strong and source link "PDF 3쪽 · 위치 보기", providing context.
Core answer section with label"정답" and five48px circular buttons1,2,3,4,5;3filledindigo. Small helper line "숫자 키 1–5로 입력". Next row "배점" with compact stepper minus,"5",plus and suffix"점"; avoid duplicated quick-value buttons.
A subtle divider then two neat aligned property rows: "유형" dropdown"독해", "난이도" segmented"기초 · 표준 · 심화" with표준active; "단원" dropdown"독서". Consistent small labels, clean fields. At bottom one disclosure row"세부 문항·영역 설정", collapsed.
Sticky inspector foot with understated previous/next arrows and "입력 후 다음 문항" toggle. Strong visual hierarchy, no repeated local saveCTA, comfortable whitespace.
RIGHT OMR: heading"정답 미리보기" and a small collapse control. A compact "18 / 20 입력" with thin90%progress bar. Small inline filter"전체" active / "미입력 2". One continuous twenty-row list, questions1–20exactlyonce, each about31px tall: questionnumber, five small circles labeled1–5, far-right"5점". Answers respectively2,4,1,5,3,2,blank,1,4,2,5,3,1,4,2,blank,3,5,1,4. Exactly one filled bubble per completed row.12selected paleindigo with option3marked,7and16have empty numbered bubbles and tiny amber dot. Remove the old green check+완료 repeated in every row. Column labels just"문항","정답","배점". Below list simple text link"학생 화면으로 보기".
BOTTOM40–50px understated status bar: left small amber dot "미입력 2문항", small clickable outlined"7번" and"16번", then quiet"미입력으로 이동". Right muted"총 배점 100점". No alarming big warning card and no suggestion completion is achieved.
Preserve counts and scores exactly. No analytics, chat, AI invented question generation, advertising, decorative imagery. This is one focused editor screen. Every control should have a believable reason and readable Korean. Clean flat surfaces, polished alignment, balanced spacing, paper only gets a slight shadow.

### 2

Use case: ui-mockup. Create realistic, production-quality UI with clear hierarchy, strong typography, intentional content and purposeful spacing. Generate ONE independent refined Korean OMR Maker desktop creation screen. Design direction "완성까지 안내하는 출제 데스크". This is a meaningful second pass on attached guided-editor concept, in response to "조금 더 디벨롭". Keep its teacher-friendly staged workflow, but visibly improve editing flow and polish.

Target1440 x1024pixels, same landscape aspect as attached. App viewport only, no browser/device chrome, poster title, external callouts, concept number, perspective, collage or clipping. Date anchor2026-09-10; no dates.
Image1=previous guided-editor to refine; image2=actual OMR Maker logo. Keep identity and existing controls: PDF/answerPDF registration,20questions,5choices,score entry,bulk editing,answer import,per-question metadata/PDF region,OMR preview,draft save,review/distribution. No analytics, invented AI question generation, chat or decorative photos.
Design system:indigo#4f46e5,navy#0f172a,muted#64748b,white#ffffff,slate#f8fafc,hairlines#e2e8f0,amber only pending. Pretendard body14–16px,headings24px,tabular numerals,flat8px-rounded controls, precise slim icons. ONE primary action. No giant pill shadows, redundant cards or long tutorial text. Distinguish user-editable answers from the blank student OMR.

EVOLUTION GOAL: Instead of a long form plus a passive thumbnail, make a calm guided correction workflow. Missing-question chips jump directly to expandable rows. The selected row reveals only its relevant PDF evidence and properties inline. Teacher can fill the missing answer without losing the table. Right preview clearly shows student mode and paper settings. Reduce wasted header height so actual work dominates.

TOP64px white header: small authentic logo "OMR Maker", breadcrumb "시험 만들기", editable title "고1 국어 · 독서 평가", right quiet "초안 저장됨", secondary"초안 저장" and overflow. No primary button up here.
STAGEBAR56px: thin elegant horizontal stepper, "시험 기본" check complete, "정답·배점"activeindigo, "검토·배포"greyupcoming. Smaller and calmer than reference, no explanatory sentences under each step.
MAIN two areas: left930px,right450px,40px outermargin,one vertical hairline.
Left title "정답·배점" with small subtitle"20문항 · 총 100점". At right of title secondaryoutlined"정답 가져오기",text"연속 입력".
Next one short amber-tinted neutral horizontal line "정답이 비어 있는 문항" with two clickable chips "7번" active and "16번"; no large warning alert or redundant errors elsewhere. Right of this row small"18 / 20 입력".
Below a slim table toolbar textfilter"전체 문항"active /"미입력만", compact"일괄 설정"menu.
A continuous editable table with fine horizontal dividers. Columns:"문항","정답","배점","유형","PDF". Show rows5–10exactlyonce to focus the current working range; each ordinary row46pxhigh. Five circular answer buttons1–5always labeled, one indigo selected per completedrow. Score5, type독해,PDF smalllink. Answers q5=3,q6=2,q7blank,q8=1,q9=4,q10=2.
q7is selected, paleindigo background with slim indigo leftborder. Its answer controls large and empty, "5"score. Row7 expands downward in place into a purposeful150–180px contextual region before row8. Expanded region contains LEFT a short readable PDF questionexcerpt: heading"7. 다음 글의 전개 방식으로 가장 적절한 것은?",three short lines of source text, fine border around a source crop, tinylink"PDF 2쪽에서 보기"; RIGHT concise two propertyfields"단원  독서" and"난이도  표준",quietlink"세부 문항 설정". This is a natural table-row expansion, not nested colorful cards. Provide a small upwards chevron to collapse row7. No new floatingmodal and no duplicate answerbuttons inside expansion.
Below row10 tablepager"5–10 / 20문항" with previousnext icons; whitespace is welcome. Bottom ofleft area a collapsed utilitystrip with fileicon,"고1_국어_독서.pdf","문제지 바꾸기" and tinycheck"PDF 연결됨". No oversized heading or giant formfield.

RIGHT: "학생 OMR 미리보기", small caption"정답은 학생 화면에 표시되지 않아요." Two subtle texttabs"학생 화면"active /"정답 보기". Tall clean upright white A4-like paper on pale slate surface, not a heavily framed card. Paper title"고1 국어 · 독서 평가",subtitle"20문항 · 100점",fields"이름" and"반". Twenty questions split into two groups1–10 and11–20, each row exactly5 EMPTY bubbles. Absolutely no marked answers on this studentmode paper. Readable rows and unclipped paper. Underpaper inline controls"2열","보통 간격" and quietlink"표시 설정" for the OMR format; not a complex mini settings dashboard. Rightpanel can be narrower than before to prioritise editing.

BOTTOM fixedfooter64px: leftsecondary"이전 단계",middlesmalltext"초안은 언제든 저장할 수 있어요",right a clear solidindigo"검토 화면으로"arrow, the only primaryCTA. This means proceed to review; never claim distributionready while7and16stillmissing.
Consistency20questions*5points=100;18answered;7and16pending. 7has no selectedanswer. Preview always blankstudentmode. This frame is a focused real workstate, not feature inventory. Prioritize grouping,alignment,whitespace,typography,dividers beforetints and borders. Make the expanded-row connection tosource and missing-question jump chips the central improvement, with exceptional visual balance and readableKorean.

### 3

Use case: ui-mockup. Create realistic, production-quality UI with strong hierarchy, typography and purposeful spacing. Generate ONE independent second-pass Korean OMR Maker teacher desktop concept. Direction name "한 문항 집중 스튜디오". Evolve the attached OMR-centered studio into a polished focused work mode: a LARGE readable question above, contextual answer controls at right, and a persistent compact full OMR navigation dock at bottom. This is a meaningful structural development requested by user, not a cosmetic reskin.

TARGET1440 x1024pixels, landscape proportion of reference. One app viewport only, no device/browser chrome, no poster framing or concept number, no perspective, no collage, no clippedcontrols. Dateanchor2026-09-10; datesunnecessary.
Image1=previous OMR studio, ground identity, task and existing controls; rearrange deliberately as the new focused mode. Image2=authentic OMR Maker logo, smallheaderuse.
Preserve current product functionalities: teacher answer-key editing for uploadedPDFs, questioncount,5choice,score,unit/difficulty,linkedquestionandsharedpassageregions,OMRpreview,draftsave,review/distribution. No AI exercise generation, chat, metrics, marketing, or invented analysis.

Existing visualsystem: white#fff,navy#0f172a,muted#64748b,slate#f8fafc,hairlines#e2e8f0,solidindigo#4f46e5,paleindigoselection,amberforpending,greenonlysmallautosavecheck. Pretendard Korean14–16pxbody,26pxheading,tabularnumbers. Refine beyond reference with flat8pxradii, thinicons, fewercontainers, rich whitespace. No glossygradients, pillglows, repeatednestedcards, or heavyborders. One primaryCTA.

LAYOUT:
HEADER64px: small real logo"OMR Maker"; verticaldivider; examtitle"고1 국어 · 독서 평가" with smaller"20문항 · 5지선다 · 100점"; right"초안 저장됨",smallundo/redo,secondary"초안 저장",ONEsolidindigo"검토하고 배포".
WORKSPACE TOOLBAR52px: left clean segmentedmode"전체 OMR" /"문항 집중"activeindigo; next text"12 / 20 문항" withprev/nextchevrons. Right small"학생 미리보기",expandandmoreicons. Noadditionalmenubars.
MAIN fromy116to790, twoareas:920pxquestioncanvasleft,520pxcontextualinspectorright. Verticalhairlinebetween. The result should feel calmer and more focused than the previous two-column OMR table.

LEFT:
Pale slate documentcanvas. Tinytoolbar alongtop"문제지"active /"참고 답지",source"고1_국어_독서.pdf · 3쪽" andquiet"원본 보기".
Large white selected-question paper crop sits centered with32pxmargins, width820px,height520px, verysubtlepageshadow. It is a readable PDF excerpt, not a full denseexam sheet and not a tinythumbnail. Small indigoanchortag"12번"atpaperupperleft. At paper top small grey context"공통 지문 11–14번" withlinkicon, and right"지문 보기"quietlink. Below strong but not enormous"12. 다음 글의 중심 생각으로 가장 적절한 것은?"
The source passage is a short readable Korean readingtext, roughly5–6lines at17px, max65characters perline. Text:
"독서는 단순히 정보를 얻는 것을 넘어, 다른 사람의 삶을 간접적으로 경험하게 하는 소중한 기회이다. 다양한 관점을 접할 수 있는 독서는 우리로 하여금 세상을 보다 넓고 깊게 이해하도록 돕는다."
Below fivechoices wellspaced:
"① 독서는 지식을 빠르게 습득하는 수단이다."
"② 사람마다 선호하는 책의 장르는 다르다."
"③ 좋은 독서는 사고의 폭을 넓혀 준다."
"④ 독서는 시간을 효율적으로 사용하는 방법이다."
"⑤ 책을 많이 읽는 것이 항상 좋은 것은 아니다."
Keep sourcepaper choices plainblack: no studentmarks or teacherannotations insidePDF. The editableanswer is ininspector. Atcanvasbottom unobtrusive"PDF 영역 연결됨" withquiet"영역 조정". No duplicatePDFtoolbarorpagecontrols.

RIGHTINSPECTOR white,32pxpadding:
Header"12번 문항",mutedline"선택한 문항만 편집합니다".
First largeessentialgroup"정답" and five48pxcircles1,2,3,4,5 with3filledindigo. Shortmutedhint"숫자 키 1–5로 입력".
Next aligned"배점" label andcompactstepperminus,"5",plus,suffix"점".
Hairlinedividerthen compact two-columnform labels above: "유형" dropdown"독해"; "난이도"dropdown"표준"; nextfullwidth"단원"field"독서". No duplicateanswerelsewhereininspector.
One collapsedrow"세부 문항·공통 지문 설정". Bottomquiettoggle"입력 후 다음 문항"on, beneathoutlinebutton"다음 문항 →". This is secondary notsolidprimary. Do notpadspacewithfeatures.

BOTTOM FULL-WIDTH OMRNAVDOCK, height~220px,whitewithhairlinetop:
Dockheader left"OMR 전체 보기",small"18 / 20 입력", a90%thinprogressline inline onlyabout140pxwide; rightquiet"미입력 2문항" withsmallchips"7번","16번" andcollapsecontrol.
Below20 miniOMR questioncells in2rows of10, firstrow1–10,second11–20, never duplicateoromitnumbers. Eachcell about132pxwide x58pxhigh, minimal spacing and no heavyroundedcard. Topline boldquestionnumber plus far-righttiny"5점". Bottomline FIVE tinybutreadable circles labeled1,2,3,4,5. Filledindigo foroneanswer ineachcompletedcell. Answerssequence2,4,1,5,3,2,blank,1,4,2,5,3,1,4,2,blank,3,5,1,4. Question12(secondrowsecondcell)palelavenderselectedwithindigoleftedge,option3marked; questions7and16fiveemptycirclesand smallamberdot. All20questions alwaysvisible in this dock andeverycirclehasalabel. This dock is notananalyticsgrid; it is functional answer-and-navigationoverview.
Do not add another footer belowdock. PrimaryCTA onlyheader.
Countconsistency20*5=100points,18filled,7and16missing,12selectedanswer3. No readinessclaimwhilepending. The image should communicate "read clearly, answer once, move confidently" by layout without including that slogan. Generate onefocused workingappscreen, highest-quality Korean typesetting, exceptionally cleanalignment and spacing, no featureinventory.

