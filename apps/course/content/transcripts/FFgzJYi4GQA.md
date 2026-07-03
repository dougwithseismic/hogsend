Hey there, JJ here. We are going to be talking about how events work inside of Posttog. Identify events, normal events, front-end events, backend events, auto capture. How do they all work in conjunction in parallel to get you a full story of how people, users are navigating your marketing, your product, and ultimately driving revenue.

You probably first installed Post Hog via GTM or straight on your site, and you were like, "Oh my goodness, this amazing data is flowing in. We're good. We're good. We're good. Everybody, happy smiles, happy tears. We are off to the races. What they then realize is start hitting limits. You start hitting the limits of Post Hog and you're like, uh-oh, we've got a problem here.

So, what is the auto capture? The auto capture is right here. You can see this auto capture event showing up here in we are under the activity. We are under explore here and we currently have the event count view. You can see here that there has been 2400 event counts and that is almost as many page views that have occurred, right?

So you're almost going to double the amount of page views using these auto capture events and then you also have these page leave events and these rage clicks and these other web vitals etc. So that auto capture adds quite a bit. If we then turn this into the post hog default view and we hop into oh look at this person right here now uh let's hop into this uh exit intended event right here.

Actually let's find one that's more more oh right look at this person right here clicked on this. So, if you hop into this actual event, you hit the little thing right here, you will see all the information that Post Hog is collecting. Right? This is Post Hog's properties. The current URL that they're on, the auto capture is, is it disabled or is it on?

You can see all of these different events that are coming in from Post Hog. And then this is what's being captured, right? They have the actual properties that are being captured alongside that event, whether they're person properties or properties of the actual event. We'll talk about that later. So, how does that work?

If you want to turn this off, which I'd recommend that you do, I don't think unless you are a very low volume site, and by low volume, I mean less than 2,000 sessions per month, you probably want to turn this off. Every client that we work with, auto capture is off because otherwise, uh, you end up with a massive volume of events.

How do you turn that off? Let's go to settings and then you're just going to turn off auto capture right here. So, if you scroll on down, turn off auto capture. There you go. You can turn off a few other things here as far as web vitals, right? You want to turn those off.

Auto capture is the big culprit of massive volume. Great, JJ. So, now that we have our auto captures off, I want to still capture other things. I want to capture when someone views a call to action, when someone views something else, when someone clicks on the call to action link. How do I do that?

I'm so glad you asked. So, what you can do is this simple script right here is you can take this script and you can deploy it via Google Tag Manager. That's our recommended method on the browser side of things. And you can say, hey, I want to copy and paste this. I'm just going to copy this and let's make a new tag.

I'm going to show you exactly how to do this. And we going to create a new HTML tag inside of Google Tag Manager. We're going to throw this in. And we have post hog.capture. And that is going to deploy right after the default base script that Post Hog has. And we could say here I want to deploy this on viewed CTA viewed.

And then here we could type in a property of what CTA name. And then you can type in the name of the name of the CTA. Maybe it's called post hog audit. So this is something you could do where you could say, hey, post.capture and the CTA viewed. And then you could have the CTA name.

We want to get rid of the color. And Bob's your uncle. You now are off to the races. And you have this capturing that event. And then we can trigger it whenever we want to. This is how you can embellish and add more events without using that auto capture to capture every single button click or link click or what whatever it might be.

You can now use tag manager to send that event in very straightforwardly to your post hog instance. Now you're probably asking yourself JJ why did you put post hog capture as CTA view? Well the event names really really do matter. We like to use the object action framework. So you basically say what the object is.

In this case, it's CTA call to action. And then the action is viewed. And then we added a property to define the name of the CTA. Hey, are you pulling your hair out right now? And like, oh my goodness, this is a lot of things to think through. Go over to visionlabs.com/cont and submit a contact form.

Just put in you want to talk about Post Hog. Let's get through it. We can run a G4 audit on your existing setup. We can mirror things over. So we can get your system better off and using both front-end data like Google Linux would and then also start using backend data to get your full life story inside of one system that then you can start acting on and then syncing it to other platforms and making your ads perform better.

This is helpful for very high volume events so you don't overwhelm yourself of trying to sift through all these events at once. You can look at the properties to say which events have been viewed. The other option I'll show you here in our exact instance is if you hop into your activities and you scroll on up here and you change this from this to event count and let's look at a bigger uh range and I'll show you some examples that we use inside of ours.

So here you can see lead generated looker studio cheat sheet. We've chose to take in that property of which cheat which lead was generated and add that here to the actual event name. So at a glance you can see how many looker student cheat sheets have been downloaded 41. Same thing for lead generated for data order of operations or our image metric grid.

We also have this lead generated general event. This event is a duplicate and also has the properties of the other events. Right? So we can count these. There's been 102 leads generated. But we also know that these are 41 of these. But they're not additive. You don't add them together. In general, we've had 101 leads that have been generated on our site.

Same thing goes for lead engage. If someone's been on one of our lead magnet pages, they get the engaged lead. And if someone's been on the has an impression, they've seen our lead magnets. This is how we structure our content using this something called a foresight system to store events in a way that makes sense down the line.

We have a ton of testing things in here. So it's a little bit of a nuance because we test so much on our end to try and make sure we deploy this the best possible way for clients. But that is how you can get browser events into the system and go from there.

Now let's run through on the backend events. Right? This is what Google Analytics 4 would call measurement protocol that is a nightmare to handle. But I'm going to show you how to do this with a low code no code solution and just give you a concept of how this might be helpful. So if you were to try and get an event into HostGO, here's a example.

You would have the web, right? They go and submit a form. You'd trigger that from the browser and say, "Hey, we triggered this event. A lead has been generated. Lead generated contact." Here would be the event, right? So be lead generated, contact us. Right? That's object action framework. And then what lead was done?

It was the contact us. Maybe you have something in your CRM, right? So, this information goes to your CRM and you say, "Hey, they're qualified. We now know they're qualified because we used six cents to figure out the information or we did something else." And now we the CRM knows they're qualified. Do you want to send this event right to PostHog of lead generated contact us qualified?

Right? You can send this event now back to Post Hog to know that they've been qualified. And maybe you have a two-step form where once they're qualified, your sales rep reaches out and you say, "Hey, hey, sales rep, we need more information." You could also send that in here, lead generated contact us qualified, and then more information, right?

Maybe you have this where you say lead generated and you say information gathered. I'm just using the same framework, right, of what was happened information and then it was gathered. These events, right, the browser doesn't happen. Maybe you have a form, maybe you have a type form, maybe you have something else that you are using to get this data to Post Hog, your CRM, maybe if you're using HubSpot, maybe something else.

So, how could you get that to Post Hog? Uh, there's a million different ways. You can use web hooks, you can use all these different methods. Uh, you can always look at the different implementation docs. It's very hard to give broad sweeping example, but if you head into settings, you can see examples for how to use that with their product analytics specifically.

Here is a low code solution to do this. Again, not the way to do it for every which way, but I just want to give you an example. So, here we are inside of a tool called Nadn. It's like a low code automation tool. And there's actually a post hog uh authentication. So, they help you with authentication.

What you can do is right here you have the event created. And I'm just going to show you exactly this work. So here we have the we're going to create an event and it's going to be called test uh lead generated contact what we just kind of ran through and I'm going to use this distinct ID which is how it identifies who we are of JJ plus 2 and we're going to have the lead name of contact size of big and I'm going to execute this step and we're going to try it out.

So the status of okay coming in I'm going to hop back into this. We're going to look at our activity report and we are going to see what has happened. There we go. So here is the person of test lead generated contact us. I am a very complicated person in life because I've tried done this so many times.

So here's all the different sessions that have been stitched together by post hog to try and figure out who I am. This is not normal. But what you can see is if you click on these events, you'll see this event come in, this test lead generated and we can see, hey, let's figure out exactly what we want to do and maybe want to add in more properties.

So you can add in person properties, set once properties. There's a million different type of properties, debugging properties or just see the raw event as it came in. And we can see here all the different types of properties and we can see the set uh of where they came in from there and then the set once right here.

So all of these options, you can see the size of big and distinct ID right here of JJ and the lead name of contact. Again, there are a million ways that this uh works. There's so many different things you can do. Um but I just want to show you this really simple way of how you can do that inside of Post Hog lead name contact size of big and you can just go hog wild.

Get it post of how to do this. Okay, now we have this concept of identify. Let me run through exactly what you can look for. Identify is Post Hog's version of saying, "How do you know if this is a person that you want to identify in their settings, by default, the identify call is used for both anonymous and non-anmous users.

So what that means is that if you're using the identify call, you're identifying anonymous person until they become anonymous and then it stitches them together and says, "Hey, this ID of 123 ABC became JJ at Vision Labs." Let me show you where those settings are because you're not going to get it by default.

I promise. Okay. So, here is this default script that you have. And then you can see person profiles of identified only. If you change this to always, which I'd recommend you do is always will create a identified a person property for every anonymous user. Everyone who's anonymous to your site, they say, "Hey, we're going to store this information until they become uh identified, right?

until they give us their email address or your phone number or create an app in your application or create a profile. They're going to store that profile as a profile that keeps getting appended to. Then once you know more information about them, you can update that using the identify call. I'm going to show you this in the backend because that's probably where you're going to end up using this.

You need to identify them in the browser as well inside of your backend. So let me just change this from an event to an identify call. And now what we're doing is we're adding properties to that person field. So maybe we want to have like I don't know company size or company name, right?

Maybe name is Vision Labs. And then here maybe we have um we want to have the company location and we're going to put Reno, Nevada. All right. So here we have identify uh and I'm just going to put JJ plus two. We're going to hit execute. And the beauty of this is is if we hop in here and we look at the identify under activity, hit reload.

There we go. So here's the identify app uh the identify event and we can hide post hog properties to make it quick. So company location is Reno, Nevada. Company name is Vision Labs and we can go to person property and we can see all of these different types of people properties set once debug all there inside of this identify call.

So that joined it to my profile, right? Said hey JJ plus 2 equals this person. We're going to combine that together and we're just going to append that to his profile. How do you identify them on the browser? It's super straightforward. All you have to do is use post hog.identify and then give them your email address.

So here we are using these double brackets, but you could just type in jj plus2 right atvisionlabs.com. I think I might have to put double quotes on this. I'm not 100% sure because I haven't hardcoded something in GTM. Okay, so this would then uh identify me. You'd put this with your variable, but you could load this in the browser once you have their email and consent.

Consent and email uh to then fire that off, right? So you'd have the event coming in from the browser and then once those downstream events happen, you can join them all together in Postto and see the entire user journey. So there you go. We've talked about the auto capture, how to name your events, why you should name events, when you want to use properties to uh either break down events or embellish those event, how to send events from the browser using GTM, and how to use uh events coming from a different method, whether that's a a web hook or the backend system.

you I showed you NADN, but you're going to have to use uh whatever type of code base that you have. Again, a little bit of a nuance there, but we now know how, at least if you wanted to do low code or no code or hack something together, you could using Naden. We then dove into identify calls of showing, hey, here's a very straightforward method of identifying on the front end so that you can identify them on the back end and now they're all identified together in one big happy family of events that live under that person profile.

And now we have a very good understanding of how events work. Any questions at all, hop over to visionlabs.com, fill out a contact form, and we could probably help you get this purring and you acting on your data, not just looking at it like you used
