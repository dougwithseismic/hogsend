Hi, I'm Edwin and I'm part of the content team here at Postto and I'll be showing you how we use product analytics [music] to help us improve and write developer documentation. So recently we overhauled a lot of our installation pages for products like error tracking [music] and that meant building a lot of new components like this steps component that essentially sequences out the content in a very structured way.

And when you compare that with our older documentation, it's a very different look and feel in terms of visual and information layout. So we use product analytics to track the user behavior and engagement with that content so [music] we can know how it's performing. So, we built this really comprehensive dashboard with lots of different insights that track page views over unique users, page views by session or user, breakdowns by URL path, the referral Google for GEO, chat GPT for AEO, as well as probably the most important insight funnels that help us actually track how well these installation pages are converting to real feature usage.

So on the left we have the [music] old installation pages converting at a rate of about 11.3% for a user who reads the page and then tries the feature to our new layout which goes about to 16.04%. So big increase and gives us great positive sign to keep going in the new direction.

Another way we use product analytics in a more low-level manner is to use SQL insights. So SQL insights lets us query the data warehouse that powers product analytics at Posthog under the hood. So I can open up the SQL editor and write queries in our own version of click house SQL across our entire event schema of Postto.

And if I want to write or create new SQL queries, I'm not the best at doing that myself, I'll admit. So I lean a lot on Postgog AI which is a really fantastic way to create, validate and fix SQL right here in Postto. So I might open the chat and ask it [music] to write a SQL query to match how many users have looked at both error tracking and feature flags and finding that intersection.

So I'll kick it off and it should generate a fully workable query for me to run. >> [music] >> And right there we have a SQL query that [music] Postto AI generated and I'll use this as a template to work off of. And I have data coming back from my SQL insight. We also [music] use product analytics to instrument new events when we ship new features or content that have no prior reference.

So for example, we shipped a new feature down here that lets you copy as markdown or view as markdown the contents of a documentation page which is great for LLMs or AI coding agents. So we use actions in post hog which is one of our most powerful features that lets you combine or filter for events under a saved name.

So we would create a new action called copy as markdown and from the auto capture events of all the activity that we're tracking we can actually target the element uh with its text. So it had copy as markdown within the div and we can specify the page URL. In this case it would be under docs.

And when we create this copy as markdown event we can create insights [music] just the same way we would with any event in post hog which allows us to create graphs or pie charts with a full breakdown of our new actions that [music] we created for copy as markdown, view as markdown, whatever we wanted.

So, this is a great way for us to track new activity for brand new behavior on docs pages that didn't exist before. Product analytics also lets us investigate things here at Postto. So, in the same dashboard that I showed you earlier for error tracking docs, we had noticed a couple weeks ago an overall spike in traffic, but a flat line for unique visitors.

So, this odd behavior led me to investigate more. And when I was creating more product analytics, I use an underrated feature at Postto called notebooks. When you create insights, you can use [music] the action side panel to add the insight to a notebook which will create a rich text editor document similar to Google Docs or notion.

So you can write in markdown, you can copy paste and with the slash command you can embed more insights that you can create directly within the notebook itself. So for my investigation, I ended up creating a notebook called investigation [music] docs traffic spike where I could write down the context, paste images from Slack of the first person who discovered the problem and then in kind of more of a narrative way explain what I thought was going on by embedding more insights, [music] my thoughts and commentary which led me to conclusion where I can also tag my teammates.

So notebooks are a really powerful way to create more of a free form report than just a dashboard. So those are a few ways the content team uses product analytics at postto. Thanks for watching. [music]
