[music] Hello everyone. How's everyone doing? >> Good. We can do better than this, right? This is React Conf. How's everyone doing? [cheering] >> Yikes. Okay. Today we're going to be talking about how to build modern emails using React. It seems like we're all thinking the same things recently, right? Like what browser should I use?

Um it seems like every single day there's a new browser uh coming out. And although it may seem hard or or difficult to choose, I actually think this is great. You know, more options. I remember when I started building software uh there was just one single browser. This one uh if you remember IE6 uh that was the browser that you would build your websites uh and you would test and you would try to make it work.

And then of course there are a few others that were a little bit smaller like Firefox and Safari and Opera. But to build a website that would work the same for every single uh browser was really difficult. You would have to use these super ugly prefixes and all these sort of polyfill JavaScript libraries.

So it was not a great uh experience at all. You would go to websites like can I use and you would have to search every single feature to make sure that it works well in that browser that you're uh targeting. Well, we don't live in that world anymore, right? We build one website now.

It works everywhere and it's beautiful. Uh, and I thought that was the case for everything that was web related until one day until the day that a designer on my team sent me this Figma file and he asked me, "Hey, can you build this? We need this email template." And yeah, here's the file.

So, it's not a super complex template, right? uh you have some uh columns and uh you have some padding going on a button all that but I quickly realized as I was building this that you know what SVG actually doesn't work on email and border radius good luck uh also doesn't work it yeah right it drives you crazy uh and you have to go to canemail.com for example to look at those uh compatibility uh checkers so to create an email that will look the Same on Gmail and Yahoo Mail and Outlook and Apple Mail.

Not only the old email clients, but the new ones, too. Super human. Hey, notion mail. Uh, it's still extremely painful. So, as a developer, I just thought, you know what? I'm sure someone fixed this problem. Uh, so let me just look around. I'm sure there's an open source project for that. So, I found this one.

Uh, and this was a really great tagline. You know, it would help me build responsive emails. So, I went to their GitHub repo and I found that the last commit was 7 years ago. So, I'm like, okay, maybe not that one. Uh, and then I found MJNL, which seemed really promising. And then I look at the docs and it was pretty outdated.

Uh, the whole experience seemed really outdated. So, decided to, you know what, let me see if I can solve that problem once and for all. Uh there's so many great technologies today. Let let me try to fix that w with those. So as uh an engineer uh what do you do when you have an idea?

You buy a domain and then you tweet about it. So that's what I did. I said, "Hey, I'm building a new side project. There was no website. There was nothing there. Uh check it out. React." And of course the first reaction was, "But why?" [laughter] Um, and that's an actually valid question. Why?

Uh, I feel like side projects are amazing because they can combine the things that you're really interested on, the skills that you want to learn. And that's where I was back then. I wanted to combine React with this new email world that I was not used to. So, let's kind of build a template together here uh with React email.

And we're going to take this Stripe email template as a reference. It just looks great. Everything that Stripe does looks great, right? So, let's use that uh as a as an example. So, we're going to do three things here. We're going to code that email template. Then, we're going to test it. And then, we're going to send it.

Those are the three things. So, let's start with coding. Well, the cool thing about React email, it has this create email package that generates all the files for you. So, we're going to get started with that. And this will generate this package JSON with React email as a dev dependency and also this email CLI that I can use.

And once I run this on my local server, I get this localhost 3000 URL and I have this environment where I can build my email template. So, this is good. Uh, it's a good first step, but I still don't have an email template. So let's start coding that. So the same way that Redex has those unstyled components, uh, React email comes with that too.

So you have body, container, and sections and buttons and you can just import those components and start using. So here we're going to just style them using uh CSS. So we're going to do like a background color container uh as well. Let's create some margins and align to the center. And this is what we have now.

So, nothing too impressive. Uh, but it's a start. Um, oops. Okay. So, let's keep adding. So, we're going to add a section with an image with a line break and some paragraphs. We're going to continue style using CSS. And now we have something. So this email looks great. Uh but no one really writes vanilla CSS these days, right?

Uh we all love Tailwind. So what if we could add Tailwind to to the game? So here's a Tailwind component and with a body and we can just use Tailwind classes. So that's much better. But we don't also use vanilla.js anymore. Uh that's at least that's what I'm seeing. Uh, TypeScript is everywhere.

So, why not create some variables? Some are optional, some are not. And we can just use those variables in our email template. And we can fail the build if those variables are not there. So, this is super cool. The power of Tailwind, the power of React, and the power of TypeScript on your email.

So, let's start testing that. Uh, here I'm going to go to the local environment. And like I the cool thing about React email is that you can toggle between uh the different uh mobile and desktop views and you can send a test email uh right from this environment. So once you send that test email you can see that on your inbox and you can send to Apple mail and see how that renders.

You can go to all and see how that renders. You can go to Outlook and it looks the same. Uh, how beautiful is that with React with Tailwind? Um, but what about broken links, right? Super common when you're building a template, you go and then sometimes you might miss uh an href. So, here we have a button with a invalid href.

So, we can tweak that uh and then go to this llinter and you can see here in the bottom that this link is broken because of an invalid syntax. So, we can go ahead fix that. Uh, but actually, let's use a broken link again. So, this is a URL that doesn't exist. This is going to return a 404.

And the cool thing about this llinter once we run it again is that uh it's going to show that there was a fetch attempt, but it returned a 404. Um [clears throat] so when we go and then we fix to an actual uh link that exists uh and run it again [snorts] it passes.

So there are other tools here like compatibility matrix and spam checker and this is super useful. Now we're ready to send. So we have the template we tested. So react email comes with this util function called render. So we can just import the function and then uh pass the component and then you get a plain HTML file.

Uh this is compatible with any service that accepts HTML. So uh you can use whatever you want. But my dream GX will be importing the component and then just calling and using that React component with all the parameters that I I want to use. So why not create a better email API too?

Uh so again I bought a domain and uh I just tweeted about it. Hey, I'm starting recent. First reaction was slowest landing page uh I've seen in 2023, but it's been a long time since 2023. Uh recent is now used by Warner Brothers and HBO Max and so many great companies. Uh there are more than 500,000 users.

Uh some of you are actually here. um recent recently uh uh raised more than $18 million uh last year. And when I Thank you. [applause] Okay. When I look back at this, I think about uh you know, I could have just had that idea for that side project and not done anything or had an idea for this email API and just said, you know what, next week I can make it or tomorrow I can make it.

Uh but if if you have an idea, if you're listening to this online or if you're here, uh I highly suggest you I highly encourage you to just start something. Make that first commit, make that first git push, uh and see what happens. If you're here at the conference, we have a booth.

Come, please say hi. If you're watching this online, hello. Uh we're actually dropping a new React email website uh to celebrate that we are here. Uh this is a sneak peek. It's going live uh tomorrow. And yeah, thank you so much [applause]
